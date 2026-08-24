export function shouldReportAgentWorkQueued({
  sessionHasActiveRun = false,
  hasRunningWorkItem = false,
  queuedWorkItemsAhead = 0
} = {}) {
  return Boolean(
    sessionHasActiveRun
    || hasRunningWorkItem
    || Number(queuedWorkItemsAhead) > 0
  );
}

export function interruptedAgentWorkRecoveryPatch(workItem) {
  if (!workItem || workItem.status !== "running") return null;
  if (workItem.source?.type === "workspace-continuation") {
    return {
      status: "queued",
      startedAt: null,
      targetTurnId: null,
      lastError: "Provider stopped before the workspace continuation settled; it was requeued."
    };
  }
  if (workItem.targetTurnId) {
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

export function assertAgentWorkSessionReference(workItem, reference) {
  if (!workItem?.sessionId || !reference?.sessionId || workItem.sessionId !== reference.sessionId) {
    const error = new Error("Queued Agent work resolved to a different product Session.");
    error.code = "AGENT_WORK_ROUTE_MISMATCH";
    throw error;
  }
  if (workItem.source?.type !== "workspace-continuation") return reference;
  const source = workItem.source;
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

export function annotateAgentWorkDetailItems(detailItems = [], workItems = []) {
  const workByTurnId = new Map(
    workItems.filter((item) => item.targetTurnId).map((item) => [item.targetTurnId, item])
  );
  const unmatchedRunningUserWork = workItems.filter((item) =>
    item.kind === "user"
    && item.status === "running"
    && !item.targetTurnId
  );

  return detailItems.map((item) => {
    let work = workByTurnId.get(item.turnId);
    if (!work && item.type === "userMessage") {
      const index = unmatchedRunningUserWork.findIndex((candidate) =>
        normalizedText(candidate.text) === normalizedText(item.text)
      );
      if (index >= 0) {
        work = unmatchedRunningUserWork.splice(index, 1)[0];
      }
    }
    if (!work) return item;
    // A queued unit owns the whole Provider turn, but only its authored input
    // carries the source semantics. Copying `collaboration` onto tool calls,
    // Automation events, reasoning, and Agent output makes those internal
    // events look like additional peer messages in presentation clients.
    const isAuthoredInput = item.type === "userMessage";
    return {
      ...item,
      userMessageStatus: item.type === "userMessage"
        ? userMessageStatusForAgentWork(work.status)
        : item.userMessageStatus,
      sourceType: isAuthoredInput ? work.kind : item.sourceType,
      sourceChannel: work.source?.type ?? null,
      localVisibility: work.localVisibility,
      workItemId: work.workItemId,
      feishuVisibility: work.source?.type === "feishu" && item.type === "userMessage"
        ? "hidden"
        : item.feishuVisibility
    };
  });
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

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}
