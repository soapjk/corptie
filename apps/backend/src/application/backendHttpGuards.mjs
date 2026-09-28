// True means the guard has already sent the rejection response.
export function rejectDevelopmentPreviewWrite({ request, response, url, developmentPreview, sendJson }) {
  if (developmentPreview) {
    // Fail closed: GET alone is insufficient (some inventory APIs probe tools).
    const readable = ["/health", "/settings", "/first-run", "/events", "/sessions",
      "/state/snapshot", "/state/changes", "/state/events", "/session-timelines/revisions",
      "/works", "/tasks", "/agents", "/workspaces", "/repositories", "/artifacts", "/memories",
      "/automations", "/scheduled-tasks", "/scheduled-session-tasks"].includes(url.pathname)
      || /^\/sessions\/[^/]+\/(stored-snapshot|history|timeline\/window|timeline\/changes|events|usage|context-references|images|fork)$/.test(url.pathname)
      || /^\/works\/[^/]+(?:\/(tasks|artifacts))?$/.test(url.pathname)
      || /^\/tasks\/[^/]+(?:\/(sessions|snapshots|artifacts))?$/.test(url.pathname)
      || /^\/artifacts\/[^/]+$/.test(url.pathname)
      || url.pathname === "/scene-templates"
      || url.pathname === "/scenes"
      || /^\/scenes\/[^/]+(?:\/(views\/[^/]+|changes))?$/.test(url.pathname);
    if (request.method !== "GET" || !readable) {
      sendJson(response, 403, { code: "DEVELOPMENT_PREVIEW_READ_ONLY",
        error: "开发版数据预览：只浏览、不执行；此操作已禁用。" });
      return true;
    }
  }

  return false;
}

export function rejectUnavailableStoreRequest({
  request, response, url, backendStoreReady, store, dataRootMigrationCoordinator, sendJson
}) {
  if (!backendStoreReady && !(
    request.method === "GET"
    && ["/health", "/events", "/settings"].includes(url.pathname)
  )) {
    sendJson(response, 503, {
      error: "The Backend transport is connected and the local Store is initializing.",
      code: "BACKEND_STORE_INITIALIZING",
      retryable: true
    });
    return true;
  }

  if (store.migrationInProgress
    && !((request.method === "GET" && (
      url.pathname === "/health"
      || url.pathname === "/settings"
      || url.pathname === "/data-root-migrations/current"
    )) || (request.method === "POST" && url.pathname === "/internal/backend/data-root-restart"))) {
    sendJson(response, 503, {
      error: "The Backend is in maintenance mode for a Data Root migration.",
      code: "DATA_ROOT_MAINTENANCE_MODE",
      operation: dataRootMigrationCoordinator.status()
    });
    return true;
  }

  return false;
}
