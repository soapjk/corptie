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
    return {
      ...item,
      sourceType: work.kind,
      sourceChannel: work.source?.type ?? null,
      localVisibility: work.localVisibility,
      workItemId: work.workItemId,
      feishuVisibility: work.source?.type === "feishu" && item.type === "userMessage"
        ? "hidden"
        : item.feishuVisibility
    };
  });
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}
