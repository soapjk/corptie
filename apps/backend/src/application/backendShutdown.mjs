export function createBackendShutdown({
  backgroundAgentService, getClientDeviceGateway, taskSummaryService,
  turnObservability, runtimeActivity, mcpCleanupInterval,
  stateSyncPublisher, scheduledSessionTaskService, getResetForecastMonitor,
  openClackyManager, feishuGateway, codexRuntime, skillMcpGateway,
  runIsolationCoordinator, projectCodeFreshnessMonitor,
  closeTimelineReadPool, store, dataRootMigrationCoordinator,
  backendDataRootOwnership
}) {
  let shutdownPromise = null;
  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      backgroundAgentService.close();
      await getClientDeviceGateway()?.close();
      taskSummaryService.close();
      turnObservability.flush();
      runtimeActivity.stopTimers();
      clearInterval(mcpCleanupInterval);
      stateSyncPublisher.cancelPendingPublish();
      runtimeActivity.closeTimelinePublisher();
      scheduledSessionTaskService.stop();
      await getResetForecastMonitor()?.stop();
      openClackyManager.stop();
      await feishuGateway.close();
      await codexRuntime.close();
      await skillMcpGateway.close();
      await runIsolationCoordinator?.close();
      projectCodeFreshnessMonitor.close();
      await closeTimelineReadPool();
      turnObservability.flush();
      await store.close({
        checkpoint: dataRootMigrationCoordinator.status()?.phase !== "restartRequired"
      });
      await backendDataRootOwnership.release();
      process.exit(0);
    })();
    return shutdownPromise;
  };
}
