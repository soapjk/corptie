export function handleSessionMutationHttpRequest({
  request, response, url, sessionDeletionPlan, sessionApplicationService,
  reserveSessionTitle, deleteSession, emitEvent, readJson, sendJson,
  errorStatus, unifiedErrorStatus, sessionTitleErrorPayload
}) {
  const sessionDeleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  const sessionDeletionPlanMatch = url.pathname.match(/^\/sessions\/([^/]+)\/deletion-plan$/);
  if (request.method === "GET" && sessionDeletionPlanMatch) {
    const rawId = decodeURIComponent(sessionDeletionPlanMatch[1]);
    sessionDeletionPlan(rawId)
      .then((plan) => sendJson(response, 200, plan))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message }));
    return true;
  }
  if (request.method === "PATCH" && sessionDeleteMatch) {
    readJson(request)
      .then(async (input) => {
        const rawId = decodeURIComponent(sessionDeleteMatch[1]);
        if (Object.prototype.hasOwnProperty.call(input, "avatarPath")) {
          sendJson(response, 400, {
            error: "Session avatars are not supported; sessions inherit their Agent avatar.",
            code: "SESSION_AVATAR_UNSUPPORTED"
          });
          return;
        }
        const title = typeof input.title === "string" ? input.title.trim() : "";
        if (!title) {
          sendJson(response, 400, { error: "Title is required" });
          return;
        }
        const releaseTitle = reserveSessionTitle(title, rawId);
        try {
          const session = await sessionApplicationService.renameSession(rawId, title, { source: "http" });
          emitEvent("SessionRenamed", { session });
          sendJson(response, 200, { session });
        } finally {
          releaseTitle();
        }
      })
      .catch((error) => {
        sendJson(response, errorStatus(error), sessionTitleErrorPayload(error));
      });
    return true;
  }

  if (request.method === "DELETE" && sessionDeleteMatch) {
    const rawId = decodeURIComponent(sessionDeleteMatch[1]);
    Promise.resolve()
      .then(async () => {
        const result = await deleteSession(rawId, { mergeWorktree: url.searchParams.get("mergeWorktree") === "true" });
        sendJson(response, 200, result);
      })
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code ?? null }));
    return true;
  }

  return false;
}
