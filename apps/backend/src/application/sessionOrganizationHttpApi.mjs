import { storedSessionIdForListSession } from "./sessionListOrder.mjs";
import { sortSessionsForList } from "./sessionListPresentation.mjs";

export function handleSessionOrganizationHttpRequest({
  request, response, url, store, archiveSession, normalizeSessionId, listGatewaySessions,
  readJson, sendJson, emitEvent, errorStatus, unifiedErrorStatus
}) {
  const sessionArchiveMatch = url.pathname.match(/^\/sessions\/([^/]+)\/archive$/);
  if (request.method === "POST" && sessionArchiveMatch) {
    readJson(request)
      .catch(() => ({}))
      .then(async (input) => {
        const rawId = decodeURIComponent(sessionArchiveMatch[1]);
        const archived = input.archived !== false;
        const session = await archiveSession(rawId, archived);
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        emitEvent(archived ? "SessionArchived" : "SessionUnarchived", { session });
        sendJson(response, 200, { session });
      })
      .catch((error) => {
        sendJson(response, errorStatus(error, unifiedErrorStatus(error)), {
          error: error.message,
          code: error.code ?? "SESSION_ARCHIVE_FAILED"
        });
      });
    return true;
  }

  const sessionPinMatch = url.pathname.match(/^\/sessions\/([^/]+)\/pin$/);
  if (request.method === "POST" && sessionPinMatch) {
    readJson(request)
      .catch(() => ({}))
      .then((input) => {
        const id = normalizeSessionId(decodeURIComponent(sessionPinMatch[1]));
        const pinned = input.pinned !== false;
        const session = store.pinSession(id, pinned);
        if (!session) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        emitEvent(pinned ? "SessionPinned" : "SessionUnpinned", { session });
        sendJson(response, 200, { session });
      });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/sessions/reorder") {
    readJson(request)
      .then((input) => {
        const sessionIds = Array.isArray(input.sessionIds) ? input.sessionIds.map((id) => String(id)) : [];
        const storedSessionIds = sessionIds.map(storedSessionIdForListSession);
        store.reorderSessions(storedSessionIds);
        emitEvent("SessionsReordered", { sessionIds });
        sendJson(response, 200, {
          sessions: sortSessionsForList(listGatewaySessions({ archived: false }))
        });
      })
      .catch((error) => {
        sendJson(response, 400, { error: error.message });
      });
    return true;
  }

  return false;
}
