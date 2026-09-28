import { mapCodexProviderNotification } from "../application/providerEventEnvelope.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

// Codex transport notifications enter the shared durable Provider event pipeline.
// Product terminal lifecycle handling remains an injected provider-neutral port.
export function createCodexNotificationReceiver({
  store, codexRuntime, sessionStateDiagnostics, requireSessionReference,
  chatResourceService, agentProviderRegistry, providerEventIngestion, now,
  scheduleCodexChoiceParseForText, handleCommittedProviderTerminalLifecycle
}) {
  function handleCodexAppServerNotificationSafely(message) {
    const method = message?.method ?? "unknown";
    const threadId = message?.params?.threadId ?? null;
    const logical = threadId ? store.getLogicalSessionByProviderThreadId(threadId) : null;
    const sessionId = logical?.legacySessionId ?? (threadId ? `codex:${threadId}` : null);
    if (method === "turn/completed" && threadId && sessionId) {
      const pendingImages = codexRuntime.liveItemsForThread(threadId).filter((item) =>
        item?.type === "imageView"
        && typeof item.text === "string"
        && item.text.trim()
        && (!Array.isArray(item.images) || item.images.length === 0)
      );
      if (pendingImages.length > 0) {
        void materializeCodexTurnImages({ threadId, sessionId, items: pendingImages })
          .finally(() => handleCodexAppServerNotificationSafely(message));
        return;
      }
    }
    if (sessionId) {
      sessionStateDiagnostics.record(sessionId, "providerReceived", {
        providerId: "codex-app-server",
        threadId,
        turnId: message?.params?.turn?.id ?? message?.params?.turnId ?? null,
        eventName: method
      });
    }
    try {
      handleCodexAppServerNotification(message);
      if (sessionId && ["turn/completed", "error"].includes(method)) {
        const persisted = store.getSession(sessionId);
        sessionStateDiagnostics.record(sessionId, "persisted", {
          status: persisted?.status ?? null,
          eventName: method
        });
      }
    } catch (error) {
      console.error(`[provider-notification] isolated failure provider=codex-app-server session=${sessionId ?? "unknown"} thread=${threadId ?? "unknown"} event=${method} code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
      if (sessionId) {
        sessionStateDiagnostics.record(sessionId, "providerError", {
          eventName: method,
          code: error?.code ?? null,
          error: error?.message ?? String(error)
        });
        const binding = threadId
          ? store.getAgentSessionBindingByProviderSession("codex-app-server", threadId)
          : null;
        if (binding) store.markProviderBindingCursorDegraded(binding, now());
      }
    }
  }

  async function materializeCodexTurnImages({ threadId, sessionId, items }) {
    const reference = requireSessionReference(sessionId);
    for (const item of items) {
      try {
        const imported = await chatResourceService.importImage(reference, {
          sourcePath: item.text,
          preserveOriginal: false
        });
        codexRuntime.attachManagedImagesToLiveItem(threadId, item.id, [{
          managedPath: imported.managedPath,
          originalPath: null
        }]);
      } catch (error) {
        console.warn(`[chat-image] could not materialize Provider image session=${sessionId} path=${item.text} code=${error?.code ?? "unknown"}`);
        // Mark the attempt so the terminal notification proceeds and the UI can
        // render a missing-image placeholder instead of retrying forever.
        codexRuntime.attachManagedImagesToLiveItem(threadId, item.id, [{
          managedPath: chatResourceService.missingImagePath(reference, item.id),
          originalPath: null
        }]);
      }
    }
  }

  function handleCodexAppServerNotification(message) {
    const method = message?.method;
    const params = message?.params ?? {};
    const threadId = params.threadId;
    if (!threadId) {
      return;
    }
    const logicalRoute = store.getLogicalSessionByProviderThreadId(threadId);
    const sessionId = logicalRoute?.legacySessionId ?? `codex:${threadId}`;
    const managedSession = store.getSession(sessionId);
    if (method === "thread/name/updated") {
      // The Provider's native Thread title is execution metadata, not Corptie
      // product state. User/API rename commands persist the Corptie title and may
      // mirror it outward; a reverse Provider callback must never overwrite it.
      return;
    }
    // Provider-switch route commits deliberately invalidate the old Provider's
    // cached projection. The durable stable projection remains a valid base for
    // the first notification from the new active thread and must not cause that
    // notification (especially turn/completed) to be dropped.
    const session = managedSession;
    if (!session) {
      return;
    }

    const providerBinding = store.getAgentSessionBindingByProviderSession("codex-app-server", threadId);
    // Supported Provider notifications always enter the same Inbox, including
    // notifications whose Binding cannot be resolved. The synthetic identity is
    // intentionally unresolvable so Ingestion durably quarantines the event
    // instead of falling back to a second Timeline/Session projection.
    const envelopeBinding = providerBinding ?? {
      bindingId: `unresolved:codex-app-server:${threadId}`,
      providerId: "codex-app-server",
      providerSessionId: threadId,
      logicalSessionId: logicalRoute?.id ?? null,
      routingVersion: Number(logicalRoute?.routingVersion ?? 1)
    };
    const providerEnvelope = mapCodexProviderNotification({
      message,
      binding: envelopeBinding,
      liveItems: codexRuntime.liveItemsForThread(threadId),
      structuredPlanEvents: agentProviderRegistry.supports("codex-app-server", AGENT_PROVIDER_CAPABILITIES.EXECUTION_PLAN_EVENTS),
      receivedAt: now()
    });
    if (providerEnvelope) {
      const ingestion = providerEventIngestion.ingest(providerEnvelope);
      if (ingestion.status === "applied") {
        handleCommittedCodexProviderEvent({
          event: ingestion.event,
          projection: ingestion.projection,
          logicalRoute,
          threadId
        });
      } else if (ingestion.status === "quarantined") {
        sessionStateDiagnostics.record(sessionId, "providerEventQuarantined", {
          eventName: method,
          code: ingestion.code,
          bindingId: providerEnvelope.bindingId
        });
      }
    }
  }

  function handleCommittedCodexProviderEvent({ event, projection, logicalRoute, threadId }) {
    const nextSession = projection?.session;
    if (!nextSession) return;

    const terminal = ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type);
    if (!terminal) return;
    const failed = event.type === "turn.failed";
    const cancelled = event.type === "turn.cancelled";
    const latestAgentMessage = [...(event.payload?.items ?? [])].reverse().find((item) =>
      item?.type === "agentMessage"
      && item?.presentationRole === "final_answer"
      && typeof item.text === "string"
      && item.text.trim()
    );
    if (!failed && !cancelled && latestAgentMessage?.text) {
      scheduleCodexChoiceParseForText(threadId, latestAgentMessage.text);
    }

    handleCommittedProviderTerminalLifecycle({ event, projection, logicalRoute });
  }
  return { handleCodexAppServerNotificationSafely };
}
