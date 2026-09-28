export function handleBackendRestartHttpRequest({
  request, response, url, dataRootMigrationCoordinator, shutdown, sendJson, scheduleShutdown = setTimeout
}) {
  if (request.method === "POST" && url.pathname === "/internal/backend/data-root-restart") {
    const operation = dataRootMigrationCoordinator.status();
    if (operation?.phase !== "restartRequired") {
      sendJson(response, 409, {
        error: "Backend restart is only available after a verified Data Root migration.",
        code: "DATA_ROOT_RESTART_NOT_READY"
      });
      return true;
    }
    dataRootMigrationCoordinator.transition("reconnecting", { restartRequired: false })
      .then(() => {
        sendJson(response, 202, { operationId: operation.operationId, accepted: true });
        scheduleShutdown(() => void shutdown(), 500).unref?.();
      })
      .catch((error) => sendJson(response, 500, {
        error: "Could not persist the Backend restart handoff.",
        code: error.code ?? "DATA_ROOT_RESTART_HANDOFF_FAILED"
      }));
    return true;
  }

  return false;
}

export function handleBackendHealthHttpRequest({
  request, response, url, developmentPreview, now, backendStoreReady, store,
  dataRootMigrationCoordinator, projectCodeIndexStore, projectCodeRunIsolationPort,
  projectCodeApplicationService, projectCodeFreshnessMonitor, sendJson
}) {
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "corptie-backend",
      developmentPreview,
      version: "0.5.4",
      time: now(),
      storeReady: backendStoreReady,
      maintenance: store.migrationInProgress,
      dataRootMigration: dataRootMigrationCoordinator.status(),
      projectCode: (() => {
        const readiness = projectCodeIndexStore.getReadiness();
        return {
          l0Exact: "ready",
          l1Catalog: readiness.status === "ready" ? "ready" : "degraded",
          l2Symbols: readiness.status === "ready" ? "ready" : "degraded",
          semantic: projectCodeRunIsolationPort ? "ready" : "unsupported",
          reasonCode: readiness.status === "unavailable" ? readiness.code : null,
          prewarm: projectCodeApplicationService.prewarmSummary(),
          freshness: projectCodeFreshnessMonitor.summary()
        };
      })()
    });
    return true;
  }

  return false;
}
