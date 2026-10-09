import { approvalRequestIsCurrent } from "./clientSessionAPI.mjs";
import { validateInteractionAnswers, withSubmittedUserInputAnswers } from "./interactionInput.mjs";

// Session interaction command boundary; pending input dispatches belong to this
// instance, while durable item status stays in the shared timeline authority.
export function createSessionInteractionCommands({
  store, requireSessionReference, sessionApplicationService, providerEventIngestion,
  handleCommittedProviderTerminalLifecycle, sendUnifiedSessionMessage, emitEvent, now,
  interruptTimeoutMs = 15_000
}) {
  async function interruptUnifiedSession(sessionId, source = { type: "desktop" }) {
    const reference = requireSessionReference(sessionId);
    const summary = reference.metadata.session;
    const activeTurnId = summary?.external?.activeTurnId
      ?? summary?.rawStatus?.activeTurnId
      ?? store.listUnsettledSessionTurns(reference.sessionId).at(-1)?.turn_id
      ?? null;
    let session;
    let timeout;
    console.info(`[session-interrupt] requested session=${reference.sessionId} binding=${reference.bindingId} turn=${activeTurnId}`);
    try {
      session = await Promise.race([
        sessionApplicationService.interrupt(sessionId, { summary, source }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Object.assign(
            new Error("Stop acknowledgement timed out; Provider execution state is unknown. No cancellation has been confirmed."),
            { code: "SESSION_INTERRUPT_TIMEOUT", statusCode: 504 }
          )), interruptTimeoutMs);
        })
      ]);
    } catch (error) {
      console.warn(`[session-interrupt] result session=${reference.sessionId} turn=${activeTurnId} code=${error?.code ?? "UNKNOWN"}`);
      const inactive = error?.code === "PROVIDER_TURN_NOT_ACTIVE"
        && error.turnId === activeTurnId && error.providerSessionId === reference.providerSessionId;
      if ((!inactive && error?.code !== "PROVIDER_SESSION_UNAVAILABLE") || !activeTurnId) throw error;
      session = settleUnavailableProviderSessionInterrupt(reference, activeTurnId, source, inactive);
    } finally {
      clearTimeout(timeout);
    }
    emitEvent("SessionRunInterrupted", {
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId,
      session,
      source
    }, { sessionId: reference.sessionId, source });
    return session;
  }

  function settleUnavailableProviderSessionInterrupt(reference, activeTurnId, source, inactive = false) {
    const timestamp = now();
    const ingestion = providerEventIngestion.ingest({
      schemaVersion: 1,
      providerId: reference.providerId,
      providerSessionId: reference.providerSessionId,
      bindingId: reference.bindingId,
      logicalSessionId: reference.logicalSessionId,
      routingVersion: reference.routingVersion,
      providerEventId: `corptie:interrupt-unavailable:${activeTurnId}`,
      providerSequence: null,
      turnId: activeTurnId,
      type: "turn.cancelled",
      occurredAt: timestamp,
      receivedAt: timestamp,
      payload: {
        nativeType: "corptie.interrupt.provider_session_unavailable",
        status: "cancelled",
        error: {
          code: inactive ? "PROVIDER_TURN_NOT_ACTIVE" : "PROVIDER_SESSION_UNAVAILABLE",
          message: inactive
            ? "The Provider confirmed no active turn; Corptie reconciled this persisted run after the user's stop request. Original completion outcome is unknown."
            : "The Provider Session no longer exists; Corptie settled its persisted run as interrupted."
        },
        source
      },
      rawPayload: { source }
    });
    if (ingestion.status === "applied") {
      const logicalRoute = reference.logicalSessionId
        ? store.getLogicalSession(reference.logicalSessionId)
        : null;
      handleCommittedProviderTerminalLifecycle({
        event: ingestion.event,
        projection: ingestion.projection,
        logicalRoute
      });
      console.warn(`[session-interrupt] settled unavailable Provider Session locally session=${reference.sessionId} turn=${activeTurnId}`);
      return ingestion.projection?.session ?? store.getSession(reference.sessionId);
    }
    if (ingestion.status === "duplicate") return store.getSession(reference.sessionId);
    const error = new Error("The unavailable Provider Session could not be settled locally.");
    error.code = ingestion.code ?? "SESSION_INTERRUPT_RECONCILIATION_FAILED";
    throw error;
  }

  async function respondUnifiedSessionApproval(sessionId, input = {}, source = { type: "desktop" }) {
    const reference = requireSessionReference(sessionId);
    const summary = reference.metadata.session;
    if (typeof input.itemId === "string" && input.itemId) {
      const item = store.getSessionItem(reference.sessionId, input.itemId);
      if (!approvalRequestIsCurrent(item, reference.bindingId, input, source)) {
        const error = new Error("Approval request is no longer current.");
        error.code = "APPROVAL_NOT_PENDING";
        throw error;
      }
    }

    const approved = input.approved === true;
    const session = await sessionApplicationService.respondToApproval(sessionId, input, { summary, source });

    emitEvent("SessionApprovalResponded", {
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId,
      approved,
      session,
      source
    }, { sessionId: reference.sessionId, source });
    return session;
  }

  const userInputDispatches = new Set();
  async function respondUnifiedSessionUserInput(sessionId, input = {}, source = { type: "desktop" }) {
    const reference = requireSessionReference(sessionId);
    const item = store.getSessionItem(reference.sessionId, input.itemId);
    const expectedStatus = source?.type === "remote-client" ? "dispatching" : "pending";
    if (!item || item.type !== "userInput" || item.status !== expectedStatus
      || (item.bindingId && item.bindingId !== reference.bindingId)) {
      const error = new Error("User-input request is no longer current.");
      error.code = "USER_INPUT_NOT_PENDING";
      throw error;
    }
    const cancelling = input.action === "cancel" && item.userInput?.canCancel === true;
    if ((input.action != null && !["submit", "cancel"].includes(input.action))
      || (input.action === "cancel" && !cancelling)
      || (!cancelling && !validateInteractionAnswers(item.userInput, input.answers))) {
      const error = new Error("Every question requires a valid answer.");
      error.code = "INVALID_USER_INPUT_ANSWER";
      throw error;
    }
    const key = `${reference.sessionId}:${item.id}`;
    if (userInputDispatches.has(key)) throw Object.assign(new Error("回答正在提交。"), { code: "USER_INPUT_IN_PROGRESS" });
    userInputDispatches.add(key);
    store.upsertTimelineItemProjection(reference.sessionId, { ...item, status: "dispatching" });
    try {
      let result;
      if (item.userInput?.responseMode === "message") {
        if (!cancelling) {
          const text = [`回答消息 ${item.id} 中的问题：`, ...item.userInput.questions.map(q => `${q.question}\n${input.answers[q.id].join("；")}`)].join("\n\n");
          await sendUnifiedSessionMessage(sessionId, text, source);
        }
        result = store.getSession(reference.sessionId);
      } else {
        result = await sessionApplicationService.respondToUserInput(sessionId, input, { summary: reference.metadata.session, source });
      }
      const current = store.getSessionItem(reference.sessionId, item.id);
      if (current && ["pending", "dispatching", "submitted"].includes(current.status)) {
        store.upsertTimelineItemProjection(reference.sessionId, {
          ...(cancelling ? current : withSubmittedUserInputAnswers(current, input.answers)),
          status: cancelling ? "cancelled" : "submitted"
        });
      }
      emitEvent("SessionUserInputResponded", { sessionId: reference.sessionId, itemId: item.id,
        status: cancelling ? "cancelled" : "submitted" }, { sessionId: reference.sessionId, source });
      return result;
    } catch (error) {
      const current = store.getSessionItem(reference.sessionId, item.id);
      if (current?.status === "dispatching") store.upsertTimelineItemProjection(reference.sessionId, { ...current,
        status: error?.code === "INVALID_USER_INPUT_ANSWER" ? "pending" : error?.code === "USER_INPUT_NOT_PENDING" ? "expired" : "unknown" });
      throw error;
    } finally { userInputDispatches.delete(key); }
  }

  return { interruptUnifiedSession, respondUnifiedSessionApproval, respondUnifiedSessionUserInput };
}
