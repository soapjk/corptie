import { deliveredStateRevision } from "./stateSyncService.mjs";

export function handleStateSyncHttpRequest({
  request, response, url, store, eventLog, sseClients, stateSyncService,
  stateSyncClients, sessionStateDiagnostics, writeStateSyncFrame, sendJson,
  scheduleHeartbeat = setInterval, cancelHeartbeat = clearInterval
}) {
  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });

    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const replay = eventLog.replayAfter(cursor);
    if (replay.gap) {
      response.write(`event: EventReplayRequired\ndata: ${JSON.stringify({
        requestedCursor: cursor,
        oldestAvailableCursor: replay.oldestId,
        latestCursor: replay.latestId
      })}\n\n`);
    }
    // A gap means this connection cannot reconstruct a causally complete event
    // sequence. Do not mix an explicit repair request with a partial tail: some
    // product events are side effects and replaying only the suffix could apply
    // them out of context. The client repairs from the durable state/timeline
    // authorities and resumes from latestCursor on its next connection.
    for (const event of replay.gap ? [] : replay.entries) {
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    sseClients.add(response);
    const heartbeat = scheduleHeartbeat(() => response.write(": keepalive\n\n"), 15_000);
    heartbeat.unref?.();
    request.on("close", () => {
      cancelHeartbeat(heartbeat);
      sseClients.delete(response);
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/state/snapshot") {
    try {
      sendJson(response, 200, stateSyncService.snapshot());
    } catch (error) {
      sendJson(response, 503, { error: error.message, code: error.code ?? "STATE_SNAPSHOT_FAILED" });
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/state/diagnostics") {
    const revision = store.stateRevision();
    const oldestRevision = store.oldestStateChangeRevision();
    const consistencyIssues = store.stateConsistencyIssues();
    const requestedTimelineSessionId = url.searchParams.get("sessionId");
    const includeTimelines = requestedTimelineSessionId
      || url.searchParams.get("includeTimelines") === "1";
    sendJson(response, 200, {
      revision,
      oldestRevision,
      replayDepth: Math.max(0, revision - oldestRevision + 1),
      connectedClients: stateSyncClients.size,
      sync: stateSyncService.diagnostics(),
      activeReconciliationRunning: false,
      ...(includeTimelines ? {
        terminalTimelines: requestedTimelineSessionId
          ? [sessionStateDiagnostics.get(requestedTimelineSessionId)].filter(Boolean)
          : sessionStateDiagnostics.list()
      } : {}),
      healthy: consistencyIssues.length === 0,
      consistencyIssues
    });
    return true;
  }


  if (request.method === "GET" && url.pathname === "/diagnostics/sqlite-queries") {
    sendJson(response, 200, store.queryMetrics({ limit: url.searchParams.get("limit") }));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/state/changes") {
    try {
      const changes = stateSyncService.changesAfter(Number(url.searchParams.get("after")));
      sendJson(response, changes.snapshotRequired ? 410 : 200, changes);
    } catch (error) {
      sendJson(response, 503, { error: error.message, code: error.code ?? "STATE_SNAPSHOT_FAILED" });
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/state/events") {
    const requestedRevision = Number(url.searchParams.get("after"));
    let changes;
    let snapshot = null;
    try {
      changes = stateSyncService.changesAfter(requestedRevision);
      if (changes.snapshotRequired) snapshot = stateSyncService.snapshot();
    } catch (error) {
      sendJson(response, 503, { error: error.message, code: error.code ?? "STATE_SNAPSHOT_FAILED" });
      return true;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.flushHeaders?.();
    if (changes.snapshotRequired) {
      writeStateSyncFrame(response, "state-snapshot", snapshot);
    } else if (changes.revision > changes.baseRevision) {
      writeStateSyncFrame(response, "state-change-set", changes);
    }
    stateSyncClients.set(response, deliveredStateRevision(changes, snapshot));
    const heartbeat = scheduleHeartbeat(() => response.write(": keepalive\n\n"), 15_000);
    heartbeat.unref?.();
    request.on("close", () => {
      cancelHeartbeat(heartbeat);
      stateSyncClients.delete(response);
    });
    return true;
  }

  return false;
}
