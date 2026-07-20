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
