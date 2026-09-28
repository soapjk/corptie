import { suspendBackendLogging } from "../utils/backendLogging.mjs";

// Data-root migration lifecycle. The caller owns service construction; stop and
// reopen ordering is defined here, with maintenance drained before closing reads.
export function createPersistentRuntimeLifecycle({
  store, dshLivePublisher, taskSessionProjection, codexChoiceProjection,
  turnObservability, runtimeActivity, stateSyncPublisher, scheduledSessionTaskService,
  getResetForecastMonitor, openClackyManager, feishuGateway, codexRuntime,
  claudeManager, closeTimelineReadPool, activateStoredBackendLogging
}) {
function inspectDataRootMigrationBlockers() {
  const blockers = [];
  const checks = [
    ["active_session_turns", "SELECT COUNT(*) AS count FROM session_turns WHERE execution_status IN ('running', 'blocked')"],
    ["agent_work_queue", "SELECT COUNT(*) AS count FROM agent_operations WHERE status IN ('queued', 'running')"],
    ["scheduled_tasks", "SELECT COUNT(*) AS count FROM scheduled_session_runs WHERE status IN ('claimed', 'queued', 'running', 'retry_wait')"],
    ["worktree_integrations", "SELECT COUNT(*) AS count FROM worktree_integration_jobs WHERE status IN ('queued', 'running', 'cancellation_requested', 'replanning')"],
    ["artifact_writes", "SELECT COUNT(*) AS count FROM artifact_content_operations WHERE status IN ('prepared', 'file_committed')"]
  ];
  for (const [kind, sql] of checks) {
    const count = Number(store.selectOne(sql)?.count ?? 0);
    if (count > 0) blockers.push({ kind, count });
  }
  if (dshLivePublisher.activeTurnCount > 0) blockers.push({ kind: "live_provider_turns", count: dshLivePublisher.activeTurnCount });
  if (taskSessionProjection.pendingMemoryCount > 0) blockers.push({ kind: "background_memory_tasks", count: taskSessionProjection.pendingMemoryCount });
  if (codexChoiceProjection.pendingCount > 0) blockers.push({ kind: "background_choice_tasks", count: codexChoiceProjection.pendingCount });
  return blockers;
}

async function quiescePersistentRuntime() {
  turnObservability.flush();
  runtimeActivity.stopTimers();
  stateSyncPublisher.cancelPendingPublish();
  runtimeActivity.closeTimelinePublisher();
  scheduledSessionTaskService.stop();
  await getResetForecastMonitor()?.stop();
  openClackyManager.stop();
  await Promise.all([
    feishuGateway.close(),
    codexRuntime.close(),
    claudeManager.close()
  ]);
  await runtimeActivity.waitForMaintenance();
  await closeTimelineReadPool();
  await suspendBackendLogging();
}

async function resumePersistentRuntime() {
  activateStoredBackendLogging();
  runtimeActivity.startTimelinePublisher();
  scheduledSessionTaskService.start();
  getResetForecastMonitor()?.start();
  openClackyManager.start();
  runtimeActivity.startQueueTimer();
  runtimeActivity.trackMaintenance(feishuGateway.initialize().catch((error) => {
    console.warn(`[feishu] gateway resume failed error=${error?.message ?? error}`);
  }));
}

  return { inspectDataRootMigrationBlockers, quiescePersistentRuntime, resumePersistentRuntime };
}
