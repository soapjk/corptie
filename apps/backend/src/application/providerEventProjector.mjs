const TERMINAL_EVENT_STATUS = new Map([
  ["turn.completed", "completed"],
  ["turn.failed", "failed"],
  ["turn.cancelled", "cancelled"]
]);

const ITEM_EVENT_TYPES = new Set([
  "user.message.accepted",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved"
]);

export class ProviderEventProjector {
  constructor({ store }) {
    if (!store?.upsertSessionTurn || !store?.upsertItemSnapshot) {
      throw new Error("ProviderEventProjector requires a Provider event projection Store.");
    }
    this.store = store;
  }

  project({ event, binding }) {
    const sessionId = binding.sessionId;
    const session = this.store.getSession(sessionId);
    if (!session) throw projectionError("SESSION_NOT_FOUND", `Session ${sessionId} is not registered.`);

    let timelineChanged = false;
    let usage = null;
    if (event.type === "usage.updated") {
      const context = normalizeContextUsage(event.payload?.tokenUsage ?? event.payload?.usage);
      if (context) {
        usage = this.store.upsertSessionUsageSnapshot({
          sessionId,
          providerId: event.providerId,
          model: session.external?.currentModel ?? null,
          context,
          updatedAt: event.receivedAt
        });
      }
    }
    if (ITEM_EVENT_TYPES.has(event.type) && event.payload?.item) {
      timelineChanged = this.persistItem(sessionId, event.payload.item, event.bindingId) || timelineChanged;
    }
    if (TERMINAL_EVENT_STATUS.has(event.type)) {
      for (const item of event.payload?.items ?? []) {
        if (!event.turnId || item?.turnId === event.turnId) {
          timelineChanged = this.persistItem(sessionId, item, event.bindingId) || timelineChanged;
        }
      }
    }

    const turnStatus = projectedTurnStatus(event);
    if (turnStatus && event.turnId) {
      const finalItem = finalItemForTurn(event.payload, event.turnId);
      this.store.upsertSessionTurn({
        sessionId,
        bindingId: event.bindingId,
        routingVersion: event.routingVersion,
        turnId: event.turnId,
        executionStatus: turnStatus,
        finalItemId: finalItem?.id ?? null,
        startedAt: event.type === "turn.started" ? event.occurredAt ?? event.receivedAt : null,
        endedAt: TERMINAL_EVENT_STATUS.has(event.type) ? event.occurredAt ?? event.receivedAt : null,
        providerSequence: event.providerSequence,
        failure: event.type === "turn.failed" ? event.payload?.error ?? {} : null,
        updatedAt: event.receivedAt
      });
      const delivery = this.store.getMessageDeliveryForProviderTurn?.(
        sessionId,
        event.bindingId,
        event.turnId
      );
      if (delivery) {
        const deliveryStatus = TERMINAL_EVENT_STATUS.has(event.type)
          ? (event.type === "turn.completed" ? "completed" : (event.type === "turn.cancelled" ? "cancelled" : "failed"))
          : "processing";
        this.store.updateMessageDelivery(delivery.deliveryId, {
          status: deliveryStatus,
          lastError: event.type === "turn.failed"
            ? event.payload?.error?.message ?? String(event.payload?.error ?? "Provider turn failed.")
            : null
        });
      }
    }

    const updatedSession = this.projectSession(session, event, binding);
    const outbox = [];
    if (timelineChanged) {
      outbox.push({
        topic: "timeline",
        revision: this.store.sessionTimelineRevision(sessionId),
        eventType: "TimelineChanged",
        payload: {
          sessionId,
          revision: this.store.sessionTimelineRevision(sessionId),
          itemId: event.itemId ?? null,
          turnId: event.turnId ?? null
        }
      });
    }
    if (updatedSession) {
      outbox.push({
        topic: "state",
        eventType: "SessionStateChanged",
        payload: { session: updatedSession }
      });
    }
    return {
      surface: event.type === "user.message.accepted" || event.type === "assistant.message.completed",
      timelineChanged,
      session: updatedSession ?? session,
      usage,
      outbox
    };
  }

  persistItem(sessionId, item, bindingId) {
    if (!item?.id) return false;
    return this.store.upsertItemSnapshot(sessionId, { ...item, bindingId }) !== false;
  }

  projectSession(session, event, binding) {
    const unsettled = this.store.listUnsettledSessionTurns(binding.sessionId);
    const status = sessionStatus(event, unsettled, session.status, binding.isCurrentRoute !== false);
    const latestAgentItem = latestAgentItemFromPayload(event.payload);
    const activityStatus = status === "blocked"
      ? "Waiting for approval"
      : status === "running"
        ? activityForEvent(event)
        : null;
    const activeTurn = unsettled.findLast?.((turn) => turn.binding_id === binding.bindingId)
      ?? unsettled.at(-1)
      ?? null;
    const next = {
      ...session,
      status,
      progress: status === "running" || status === "blocked" ? 0.5 : 1,
      summary: latestAgentItem?.text || session.summary,
      activityStatus,
      suggestedOptions: event.type === "approval.requested"
        ? event.payload?.item?.options ?? session.suggestedOptions
        : session.suggestedOptions,
      suggestedPrompt: event.type === "approval.requested"
        ? event.payload?.item?.text ?? session.suggestedPrompt
        : session.suggestedPrompt,
      updatedAt: event.receivedAt,
      capabilities: {
        ...(session.capabilities ?? {}),
        canInterrupt: unsettled.length > 0
      },
      external: {
        ...(session.external ?? {}),
        activeTurnId: activeTurn?.turn_id ?? null,
        lastSettledTurnId: TERMINAL_EVENT_STATUS.has(event.type)
          ? event.turnId ?? session.external?.lastSettledTurnId ?? null
          : session.external?.lastSettledTurnId ?? null,
        rawStatus: status
      }
    };
    if (sameSessionExecutionProjection(session, next)) return null;
    this.store.upsertSession({
      ...next,
      provider: next.external?.provider ?? binding.providerId,
      cwd: next.external?.cwd,
      command: next.external?.source ?? binding.providerId
    });
    return this.store.getSession(binding.sessionId);
  }
}

function normalizeContextUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const active = value.last ?? value.lastUsage ?? value.last_usage
    ?? value.total ?? value.totalUsage ?? value.total_usage ?? value;
  const usedTokens = finiteUsageNumber(
    active.usedTokens ?? active.totalTokens ?? active.total_tokens ?? value.usedTokens ?? value.totalTokens
  );
  const contextWindow = finiteUsageNumber(
    value.contextWindow ?? value.context_window ?? value.modelContextWindow ?? value.model_context_window
  );
  const remainingTokens = finiteUsageNumber(value.remainingTokens ?? value.remaining_tokens)
    ?? (usedTokens != null && contextWindow != null ? Math.max(0, contextWindow - usedTokens) : null);
  const usedPercent = finiteUsageNumber(value.usedPercent ?? value.used_percent)
    ?? (usedTokens != null && contextWindow ? Math.min(100, usedTokens / contextWindow * 100) : null);
  if ([usedTokens, contextWindow, remainingTokens, usedPercent].every((item) => item == null)) return null;
  return { usedTokens, contextWindow, remainingTokens, usedPercent };
}

function finiteUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function projectedTurnStatus(event) {
  if (TERMINAL_EVENT_STATUS.has(event.type)) return TERMINAL_EVENT_STATUS.get(event.type);
  if (event.type === "approval.requested") return "blocked";
  if (event.type === "turn.started" || ITEM_EVENT_TYPES.has(event.type)) return "running";
  return null;
}

function sessionStatus(event, unsettled, previousStatus, isCurrentRoute) {
  if (unsettled.some((turn) => turn.execution_status === "blocked")) return "blocked";
  if (unsettled.length > 0) return "running";
  if (event.type === "provider.error" && isCurrentRoute) {
    return event.payload?.willRetry ? "running" : "failed";
  }
  const terminal = TERMINAL_EVENT_STATUS.get(event.type);
  if (!terminal || !isCurrentRoute) return previousStatus;
  return terminal === "completed" ? "complete" : terminal;
}

function finalItemForTurn(payload, turnId) {
  return [...(payload?.items ?? [])].reverse().find((item) =>
    item?.turnId === turnId
    && item?.type === "agentMessage"
    && item?.presentationRole === "final_answer"
  ) ?? null;
}

function latestAgentItemFromPayload(payload) {
  const items = payload?.items ?? (payload?.item ? [payload.item] : []);
  return [...items].reverse().find((item) =>
    item?.type === "agentMessage"
    && typeof item.text === "string"
    && item.text.trim()
  ) ?? null;
}

function activityForEvent(event) {
  if (event.type === "provider.error") return event.payload?.willRetry ? "Reconnecting" : null;
  if (event.type.startsWith("tool.")) return "Using tool";
  if (event.type.startsWith("assistant.message")) return "Responding";
  return "Working";
}

function sameSessionExecutionProjection(left, right) {
  return left.status === right.status
    && left.progress === right.progress
    && left.summary === right.summary
    && left.activityStatus === right.activityStatus
    && JSON.stringify(left.suggestedOptions ?? null) === JSON.stringify(right.suggestedOptions ?? null)
    && left.suggestedPrompt === right.suggestedPrompt
    && left.capabilities?.canInterrupt === right.capabilities?.canInterrupt
    && left.external?.activeTurnId === right.external?.activeTurnId
    && left.external?.lastSettledTurnId === right.external?.lastSettledTurnId
    && left.external?.rawStatus === right.external?.rawStatus;
}

function projectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
