import { mapClaudeProviderEvent, mapClaudeTurnSettled } from "../application/providerEventEnvelope.mjs";
import { agentWorkFailureMessage } from "../utils/agentWorkQueue.mjs";

// Claude-native ingress is isolated from the product composition root. The
// durable event ingester remains the only authority applying Provider events.
export function createClaudeNotificationReceiver({
  store, emitEvent, sessionWithLogicalWorkspace, providerEventIngestion,
  sessionStateDiagnostics, now, workspaceContinuationCoordinator,
  settleEntityTaskFromSession, collaborationCore, refreshWorkspaceInventoryAfterTurn,
  continuePendingWorkspaceTransition, continuePendingProviderSwitch,
  resumeWorkAfterTransition, scheduleAgentWorkDrain
}) {
async function commitManagedClaudeWorkspaceRoute(event) {
  const logical = store.getLogicalSession(event.logicalSessionId);
  const session = logical?.legacySessionId
    ? store.getSession(logical.legacySessionId)
    : null;
  if (!session) return;
  emitEvent("SessionWorkspaceSwitched", {
    session: sessionWithLogicalWorkspace(session, logical),
    ...event
  }, { sessionId: logical.legacySessionId });
}

function handleClaudeProviderEventSafely(event) {
  const logical = store.getLogicalSessionByProviderSessionId("claude-sdk", event.providerSessionId);
  const sessionId = logical?.legacySessionId ?? null;
  try {
    const binding = store.getAgentSessionBindingByProviderSession("claude-sdk", event.providerSessionId);
    const envelopeBinding = binding ?? {
      bindingId: `unresolved:claude-sdk:${event.providerSessionId}`,
      providerId: "claude-sdk",
      providerSessionId: event.providerSessionId,
      logicalSessionId: logical?.logicalSessionId ?? null,
      routingVersion: Number(logical?.routingVersion ?? 1)
    };
    const envelope = mapClaudeProviderEvent({ event, binding: envelopeBinding, receivedAt: now() });
    if (!envelope) return;
    const ingestion = providerEventIngestion.ingest(envelope);
    if (ingestion.status === "quarantined" && sessionId) {
      sessionStateDiagnostics.record(sessionId, "providerEventQuarantined", {
        eventName: event.type,
        code: ingestion.code,
        bindingId: envelope.bindingId
      });
    }
  } catch (error) {
    console.error(`[provider-notification] isolated failure provider=claude-sdk session=${sessionId ?? "unknown"} event=${event?.type ?? "unknown"} code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
    if (sessionId) {
      sessionStateDiagnostics.record(sessionId, "providerError", {
        eventName: event?.type ?? "unknown",
        code: error?.code ?? null,
        error: error?.message ?? String(error)
      });
      const binding = store.getAgentSessionBindingByProviderSession("claude-sdk", event.providerSessionId);
      if (binding) store.markProviderBindingCursorDegraded(binding, now());
    }
  }
}

async function handleClaudeTurnSettledSafely(event) {
  const logical = store.getLogicalSessionByProviderSessionId("claude-sdk", event.providerSessionId);
  const sessionId = logical?.legacySessionId ?? null;
  if (sessionId) {
    sessionStateDiagnostics.record(sessionId, "providerReceived", {
      providerId: "claude-sdk",
      turnId: event.turnId ?? null,
      eventName: `turn/${event.status ?? "settled"}`
    });
  }
  try {
    await handleClaudeTurnSettled(event);
    if (sessionId) {
      sessionStateDiagnostics.record(sessionId, "persisted", {
        status: store.getSession(sessionId)?.status ?? null,
        eventName: `turn/${event.status ?? "settled"}`
      });
    }
  } catch (error) {
    console.error(`[provider-notification] isolated failure provider=claude-sdk session=${sessionId ?? "unknown"} event=turn/${event.status ?? "settled"} code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
    if (sessionId) {
      sessionStateDiagnostics.record(sessionId, "providerError", {
        eventName: `turn/${event.status ?? "settled"}`,
        code: error?.code ?? null,
        error: error?.message ?? String(error)
      });
      const binding = store.getAgentSessionBindingByProviderSession("claude-sdk", event.providerSessionId);
      if (binding) store.markProviderBindingCursorDegraded(binding, now());
    }
  }
}

async function handleClaudeTurnSettled(event) {
  const logical = store.getLogicalSessionByProviderSessionId("claude-sdk", event.providerSessionId);
  const sessionId = logical?.legacySessionId ?? null;
  const binding = store.getAgentSessionBindingByProviderSession("claude-sdk", event.providerSessionId);
  const envelopeBinding = binding ?? {
    bindingId: `unresolved:claude-sdk:${event.providerSessionId}`,
    providerId: "claude-sdk",
    providerSessionId: event.providerSessionId,
    logicalSessionId: logical?.logicalSessionId ?? null,
    routingVersion: Number(logical?.routingVersion ?? 1)
  };
  const envelope = mapClaudeTurnSettled({ event, binding: envelopeBinding, receivedAt: now() });
  const ingestion = providerEventIngestion.ingest(envelope);
  if (ingestion.status !== "applied") return;
  const runningWork = store.getRunningAgentTaskForSession(sessionId);
  if (runningWork) {
    const updatedWork = store.updateAgentTask(runningWork.taskId, {
      status: event.status === "completed" ? "completed" : (event.status === "cancelled" ? "cancelled" : "failed"),
      targetTurnId: event.turnId,
      lastError: agentWorkFailureMessage(event.error)
    });
    emitEvent("AgentWorkCompleted", { sessionId, task: updatedWork }, {
      sessionId,
      source: runningWork.source
    });
    workspaceContinuationCoordinator.recordWorkSettled(updatedWork);
  }
  settleEntityTaskFromSession(store.getSession(sessionId));
  const agent = collaborationCore.getAgentForSession(sessionId);
  if (event.status === "completed") {
    refreshWorkspaceInventoryAfterTurn(logical);
    const continuation = continuePendingWorkspaceTransition(logical, event.turnId);
    const providerSwitch = continuePendingProviderSwitch(logical);
    resumeWorkAfterTransition(continuation, () => {
      scheduleAgentWorkDrain(sessionId);
    });
    if (providerSwitch) {
      providerSwitch.then(() => scheduleAgentWorkDrain(sessionId));
    }
  } else if (agent) {
    scheduleAgentWorkDrain(sessionId);
  }
}

  return {
    commitManagedClaudeWorkspaceRoute,
    handleClaudeProviderEventSafely,
    handleClaudeTurnSettledSafely
  };
}
