export function shouldReportAgentWorkQueued({
  sessionHasActiveRun = false,
  hasRunningTask = false,
  queuedTasksAhead = 0
} = {}) {
  return Boolean(
    sessionHasActiveRun
    || hasRunningTask
    || Number(queuedTasksAhead) > 0
  );
}

export function interruptedAgentWorkRecoveryPatch(task) {
  if (!task || task.status !== "running") return null;
  if (task.source?.type === "workspace-continuation") {
    return {
      status: "queued",
      startedAt: null,
      targetTurnId: null,
      lastError: "Provider stopped before the workspace continuation settled; it was requeued."
    };
  }
  if (task.targetTurnId) {
    return {
      status: "cancelled",
      lastError: "Provider stopped after dispatch; message was not resent."
    };
  }
  return {
    status: "queued",
    startedAt: null,
    targetTurnId: null,
    lastError: "Provider stopped before dispatch; work was requeued."
  };
}

export function assertAgentWorkSessionReference(task, reference) {
  if (!task?.sessionId || !reference?.sessionId || task.sessionId !== reference.sessionId) {
    const error = new Error("Queued Agent work resolved to a different product Session.");
    error.code = "AGENT_WORK_ROUTE_MISMATCH";
    throw error;
  }
  if (task.source?.type !== "workspace-continuation") return reference;
  const source = task.source;
  if (source.productSessionId !== reference.sessionId
    || source.logicalSessionId !== reference.logicalSessionId
    || source.bindingId !== reference.bindingId
    || source.providerSessionId !== reference.providerSessionId
    || source.routingVersion !== reference.routingVersion) {
    const error = new Error("Queued workspace continuation resolved to a stale Provider binding.");
    error.code = "STALE_WORKSPACE_CONTINUATION";
    throw error;
  }
  return reference;
}

export function userMessageStatusForAgentWork(status) {
  switch (status) {
    case "queued": return "queued";
    case "running": return "processing";
    case "completed": return "consumed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return null;
  }
}

export function agentWorkFailureMessage(error) {
  if (error == null) return null;
  if (typeof error === "string") return error;
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
