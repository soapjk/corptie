import { sortSessionsForList, withLastMessageTimestamp, withSessionMessageCursors } from "./sessionListPresentation.mjs";

export function handleSessionCollectionHttpRequest({
  request, response, url, sessions, store, agentProviderRegistry,
  listGatewaySessionPage, requestedProviderId, createSessionThroughApplication,
  sessionForkService, readJson, sendJson, errorStatus, unifiedErrorStatus, sessionTitleErrorPayload
}) {
  if (request.method === "GET" && url.pathname === "/sessions") {
    const includeMock = url.searchParams.get("includeMock") === "true";
    const archived = url.searchParams.get("archived") === "true";
    let cursor;
    try {
      cursor = decodeSessionPageCursor(url.searchParams.get("cursor"));
    } catch (error) {
      sendJson(response, 400, { error: error.message, code: error.code });
      return true;
    }
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 50;
    const requestedSessionKind = url.searchParams.get("sessionKind");
    const sessionKind = requestedSessionKind && ["assistantChat", "workChat", "worker"].includes(requestedSessionKind)
      ? requestedSessionKind
      : null;
    if (requestedSessionKind && !sessionKind) {
      sendJson(response, 400, {
        error: "Invalid Session kind filter.",
        code: "INVALID_SESSION_KIND"
      });
      return true;
    }
    const sessionId = url.searchParams.get("sessionId")?.trim() || null;
    const mockSessions = includeMock ? Array.from(sessions.values()) : [];
    const providerPage = listGatewaySessionPage({ archived, cursor, limit, sessionKind, sessionId });
    const pageSessionIds = providerPage.items.map((session) => session.id);
    const latestMessageTimes = store.listLatestSessionMessageTimes(pageSessionIds);
    const messageCursors = store.listSessionMessageCursors(pageSessionIds);
    const timelineRevisions = store.listSessionTimelineRevisions(pageSessionIds);
    const providerSessions = providerPage.items.map((session) =>
      withSessionMessageCursors(
        withLastMessageTimestamp(session, latestMessageTimes.get(session.id)),
        messageCursors.get(session.id),
        timelineRevisions.get(session.id)
      )
    );
    const providerCounts = providerSessions.reduce((counts, session) => {
      const providerId = session.external?.provider ?? "unknown";
      counts[providerId] = (counts[providerId] ?? 0) + 1;
      return counts;
    }, {});
    sendJson(response, 200, {
      sessions: sortSessionsForList([
        ...providerSessions,
        ...(archived ? [] : mockSessions)
      ]),
      sources: Object.fromEntries(agentProviderRegistry.descriptors().map((provider) => [
        provider.id,
        { ok: true, count: providerCounts[provider.id] ?? 0 }
      ])),
      mock: {
        ok: true,
        count: archived ? 0 : mockSessions.length,
        included: includeMock && !archived
      },
      page: {
        limit,
        hasMore: providerPage.hasMore,
        nextCursor: encodeSessionPageCursor(providerPage.nextCursor)
      }
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    readJson(request)
      .then(async (input) => {
        const providerId = requestedProviderId(input.providerId ?? input.agent);
        const session = await createSessionThroughApplication(providerId, input, { source: "http" });
        sendJson(response, 201, { session });
      })
      .catch((error) => {
        sendJson(response, errorStatus(error, unifiedErrorStatus(error)), sessionTitleErrorPayload(error));
      });
    return true;
  }

  const sessionForkMatch = url.pathname.match(/^\/sessions\/([^/]+)\/fork$/);
  if (sessionForkMatch && ["GET", "POST"].includes(request.method)) {
    const sessionId = decodeURIComponent(sessionForkMatch[1]);
    const operation = request.method === "GET"
      ? sessionForkService.preview(sessionId, url.searchParams.get("itemId"))
      : readJson(request).then(input => sessionForkService.create(sessionId, input));
    operation.then(result => sendJson(response, request.method === "POST" ? 201 : 200, result))
      .catch(error => sendJson(response, errorStatus(error, 409), { error: error.message, code: error.code ?? "FORK_FAILED" }));
    return true;
  }

  return false;
}

function encodeSessionPageCursor(cursor) {
  return cursor
    ? Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
    : null;
}

function decodeSessionPageCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed?.updatedAt !== "string" || !parsed.updatedAt
      || typeof parsed?.id !== "string" || !parsed.id) throw new Error("invalid");
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    const error = new Error("Invalid Session page cursor.");
    error.code = "INVALID_SESSION_CURSOR";
    error.statusCode = 400;
    throw error;
  }
}
