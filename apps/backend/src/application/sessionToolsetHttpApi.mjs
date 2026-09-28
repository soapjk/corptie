import { PROJECT_TOOLSET_ISOLATED_ACTIONS } from "../runtime/projectToolsetManager.mjs";

export function handleSessionToolsetHttpRequest({
  request, response, url, projectToolsetStatus, projectWorkingDirectoryForSession,
  projectToolsetAuthenticatedSession, projectToolsetInitializer, projectToolsets,
  projectToolsetRunIsolationOptions, readJson, sendJson, errorStatus, emitEvent
}) {
  const sessionProjectToolsetMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/project-toolset(?:\/(initialize|update|cancel|profile|start|restart|stop))?$/
  );
  if (request.method === "GET" && sessionProjectToolsetMatch && !sessionProjectToolsetMatch[2]) {
    const sessionId = decodeURIComponent(sessionProjectToolsetMatch[1]);
    projectToolsetStatus(sessionId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, errorStatus(error, 400), { error: error.message }));
    return true;
  }
  if (request.method === "POST" && sessionProjectToolsetMatch) {
    const sessionId = decodeURIComponent(sessionProjectToolsetMatch[1]);
    const action = sessionProjectToolsetMatch[2];
    Promise.resolve()
      .then(async () => {
        const cwd = projectWorkingDirectoryForSession(sessionId);
        const input = await readJson(request);
        if (action === "initialize" || action === "update") {
          const authenticatedSession = projectToolsetAuthenticatedSession(sessionId);
          void projectToolsetInitializer.schedule(cwd, {
            force: action === "update",
            authenticatedSession,
            idempotencyKey: input.idempotencyKey
          }).catch(() => {});
          sendJson(response, 202, { scheduled: true, action });
          return;
        }
        if (action === "cancel") {
          const operationId = String(input.operationId ?? "").trim();
          if (!operationId) throw Object.assign(new Error("operationId is required."), { code: "TOOLSET_CANCEL_REQUIRED", statusCode: 400 });
          const operation = await projectToolsetInitializer.cancel(operationId);
          sendJson(response, 200, { operation });
          return;
        }
        if (action === "profile") {
          const profileId = String(input.profileId ?? "").trim();
          if (!profileId) throw new Error("A Corptie service profile is required.");
          const toolset = await projectToolsets.selectProfile(cwd, profileId);
          const status = await projectToolsetStatus(sessionId);
          emitEvent("ProjectServiceProfileChanged", { sessionId, profileId, toolset, ...status }, { sessionId });
          sendJson(response, 200, status);
          return;
        }
        const isolatedAction = PROJECT_TOOLSET_ISOLATED_ACTIONS.includes(action);
        const runIsolation = isolatedAction ? await projectToolsetRunIsolationOptions(sessionId, cwd, action) : null;
        const result = await projectToolsets.run(cwd, action, { ...(runIsolation ? { runIsolation, sourceIdentity: runIsolation.sourceIdentity } : {}), ...(action === "start" || action === "restart" ? { timeoutMs: 60_000 } : {}) });
        const status = await projectToolsetStatus(sessionId);
        emitEvent("ProjectServiceChanged", { sessionId, action, result, ...status }, { sessionId });
        sendJson(response, result.ok ? 200 : 409, { action: result, ...status });
      })
      .catch((error) => sendJson(response, errorStatus(error, 400), { error: error.message }));
    return true;
  }
  return false;
}
