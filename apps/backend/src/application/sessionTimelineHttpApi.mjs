import { activeStoredSessionProjections } from "./providerSessionProjection.mjs";
import { DEFAULT_SESSION_HISTORY_WINDOW, MAX_SESSION_HISTORY_PAGE, normalizeSessionHistoryLimit } from "./sessionHistoryWindow.mjs";

export function handleSessionTimelineHttpRequest({
  request, response, url, store, sessionApplicationService,
  getStoredSessionSnapshot, getTimelineReadPool, readSessionUsage,
  readSessionHistory, readSessionTimelineWindow, publishStateChangesIfNeeded,
  readJson, sendJson, unifiedErrorStatus
}) {
  if (request.method === "GET" && url.pathname === "/session-timelines/revisions") {
    const activeSessionIds = activeStoredSessionProjections(store).map((session) => session.id);
    sendJson(response, 200, {
      sessions: [...store.listSessionTimelineRevisions(activeSessionIds)].map(([sessionId, revision]) => ({
        sessionId,
        timelineRevision: revision
      }))
    });
    return true;
  }

  const storedSessionSnapshotMatch = url.pathname.match(/^\/sessions\/([^/]+)\/stored-snapshot$/);
  if (request.method === "GET" && storedSessionSnapshotMatch) {
    const sessionId = decodeURIComponent(storedSessionSnapshotMatch[1]);
    getStoredSessionSnapshot(sessionId)
      .then((snapshot) => sendJson(response, 200, {
        timelineRevision: snapshot.timelineRevision,
        session: snapshot
      }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const sessionTimelineChangesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/timeline\/changes$/);
  if (request.method === "GET" && sessionTimelineChangesMatch) {
    const sessionId = decodeURIComponent(sessionTimelineChangesMatch[1]);
    sessionApplicationService.referenceFor(sessionId)
      .then((reference) => getTimelineReadPool().readTimelineChanges({
        sessionId: reference.sessionId,
        after: Number(url.searchParams.get("after") ?? 0),
        limit: Number(url.searchParams.get("limit") ?? 200)
      }))
      .then((result) => sendJson(response, result.snapshotRequired ? 410 : 200, result))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const sessionUsageMatch = url.pathname.match(/^\/sessions\/([^/]+)\/usage$/);
  if (request.method === "GET" && sessionUsageMatch) {
    const sessionId = decodeURIComponent(sessionUsageMatch[1]);
    const session = store.getSession(sessionId);
    if (!session) {
      sendJson(response, 404, { error: "Session not found." });
      return true;
    }
    readSessionUsage(sessionId, session)
      .then((usage) => sendJson(response, 200, usage))
      .catch((error) => sendJson(response, 503, { error: error.message }));
    return true;
  }

  const sessionEventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
  if (request.method === "GET" && sessionEventsMatch) {
    const sessionId = decodeURIComponent(sessionEventsMatch[1]);
    sessionApplicationService.referenceFor(sessionId)
      .then((reference) => {
        const hasAfter = url.searchParams.has("after");
        const after = Number(url.searchParams.get("after") || 0);
        const beforeSequence = url.searchParams.get("beforeSequence");
        const limit = Number(url.searchParams.get("limit") || 200);
        const events = beforeSequence != null || !hasAfter
          ? store.listSessionEventPage(reference.sessionId, { beforeSequence, limit })
          : store.listSessionEvents(reference.sessionId, after, limit);
        sendJson(response, 200, {
          sessionId: reference.logicalSessionId ?? reference.sessionId,
          legacySessionId: reference.sessionId,
          events,
          lastEventSequence: store.lastSessionEventSequence(reference.sessionId),
          beforeSequence: events[0]?.sequence ?? null,
          hasMoreHistory: !hasAfter && events.length >= Math.max(1, Math.min(500, limit || 200))
            && Number(events[0]?.sequence ?? 0) > 1
        });
      })
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const sessionReadReceiptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/read-receipt$/);
  if (request.method === "POST" && sessionReadReceiptMatch) {
    const publicSessionId = decodeURIComponent(sessionReadReceiptMatch[1]);
    readJson(request)
      .then(async (input) => {
        const reference = await sessionApplicationService.referenceFor(publicSessionId);
        const receipt = store.markSessionMessagesRead(
          reference.sessionId,
          input?.throughSequence
        );
        setImmediate(publishStateChangesIfNeeded);
        sendJson(response, 200, {
          sessionId: reference.logicalSessionId ?? reference.sessionId,
          legacySessionId: reference.sessionId,
          ...receipt
        });
      })
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const sessionHistoryMatch = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
  if (request.method === "GET" && sessionHistoryMatch) {
    const sessionId = decodeURIComponent(sessionHistoryMatch[1]);
    const before = url.searchParams.get("before") || null;
    const limit = normalizeSessionHistoryLimit(
      url.searchParams.get("limit"),
      MAX_SESSION_HISTORY_PAGE
    );
    readSessionHistory(sessionId, before, limit)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }

  const sessionTimelineWindowMatch = url.pathname.match(/^\/sessions\/([^/]+)\/timeline\/window$/);
  if (request.method === "GET" && sessionTimelineWindowMatch) {
    const sessionId = decodeURIComponent(sessionTimelineWindowMatch[1]);
    const anchorKind = url.searchParams.get("anchorKind") === "turn" ? "turn" : "item";
    const anchorId = url.searchParams.get("anchor") || null;
    const before = normalizeSessionHistoryLimit(
      url.searchParams.get("before") ?? 40,
      MAX_SESSION_HISTORY_PAGE
    );
    const after = normalizeSessionHistoryLimit(
      url.searchParams.get("after") ?? 40,
      MAX_SESSION_HISTORY_PAGE
    );
    const limit = normalizeSessionHistoryLimit(
      url.searchParams.get("limit") ?? DEFAULT_SESSION_HISTORY_WINDOW,
      DEFAULT_SESSION_HISTORY_WINDOW
    );
    readSessionTimelineWindow(sessionId, { anchorKind, anchorId, before, after, limit })
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }

  return false;
}
