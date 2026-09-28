import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { handleStateSyncHttpRequest } from "../src/application/stateSyncHttpApi.mjs";

function fixture() {
  const timers = [];
  const cleared = [];
  const dependencies = {
    store: {
      stateRevision: () => 10, oldestStateChangeRevision: () => 4, stateConsistencyIssues: () => [],
      queryMetrics: (input) => input
    },
    eventLog: { replayAfter: () => ({ gap: false, entries: [{ id: 4, type: "updated" }], oldestId: 4, latestId: 4 }) },
    sseClients: new Set(), stateSyncClients: new Map(),
    stateSyncService: {
      snapshot: () => ({ revision: 10 }),
      changesAfter: () => ({ baseRevision: 8, revision: 10, snapshotRequired: false }),
      diagnostics: () => ({ ready: true })
    },
    sessionStateDiagnostics: { get: (id) => ({ id }), list: () => [{ id: "all" }] },
    writeStateSyncFrame: (response, name, data) => response.frames.push({ name, data }),
    sendJson: (response, status, body) => { response.status = status; response.body = body; },
    scheduleHeartbeat: (callback, delay) => {
      const timer = { callback, delay, unreferenced: false, unref() { this.unreferenced = true; } };
      timers.push(timer);
      return timer;
    },
    cancelHeartbeat: (timer) => cleared.push(timer)
  };
  function dispatch(path, method = "GET") {
    const request = Object.assign(new EventEmitter(), { method });
    const response = {
      chunks: [], frames: [],
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      write(data) { this.chunks.push(data); },
      flushHeaders() { this.flushed = true; }
    };
    const handled = handleStateSyncHttpRequest({ ...dependencies, request, response, url: new URL(path, "http://localhost") });
    return { handled, request, response };
  }
  return { dependencies, timers, cleared, dispatch };
}

test("event replay gaps send a repair instruction without a partial tail", () => {
  const f = fixture();
  f.dependencies.eventLog.replayAfter = () => ({ gap: true, oldestId: 4, latestId: 8, entries: [{ id: 8, type: "must-not-replay" }] });
  const { response, request } = f.dispatch("/events?cursor=1");
  assert.equal(response.status, 200);
  assert.equal(response.chunks.length, 1);
  assert.match(response.chunks[0], /event: EventReplayRequired/);
  assert.match(response.chunks[0], /"latestCursor":8/);
  assert.ok(!response.chunks[0].includes("must-not-replay"));
  assert.equal(f.dependencies.sseClients.has(response), true);
  request.emit("close");
  assert.equal(f.dependencies.sseClients.size, 0);
  assert.deepEqual(f.cleared, f.timers);
});

test("event replay and heartbeats preserve framing and release resources on close", () => {
  const f = fixture();
  const { request, response } = f.dispatch("/events?cursor=3");
  assert.equal(response.chunks[0], 'id: 4\nevent: updated\ndata: {"id":4,"type":"updated"}\n\n');
  assert.equal(f.timers[0].delay, 15000);
  assert.equal(f.timers[0].unreferenced, true);
  f.timers[0].callback();
  assert.equal(response.chunks.at(-1), ": keepalive\n\n");
  request.emit("close");
  assert.equal(f.dependencies.sseClients.size, 0);
  assert.deepEqual(f.cleared, f.timers);
});

test("state event delivery tracks the revision actually sent and closes cleanly", () => {
  for (const snapshotRequired of [false, true]) {
    const f = fixture();
    f.dependencies.stateSyncService.changesAfter = () => ({ baseRevision: 8, revision: 9, snapshotRequired });
    const { request, response } = f.dispatch("/state/events?after=8");
    assert.equal(response.flushed, true);
    assert.equal(response.frames[0].name, snapshotRequired ? "state-snapshot" : "state-change-set");
    assert.equal(f.dependencies.stateSyncClients.get(response), snapshotRequired ? 10 : 9);
    request.emit("close");
    assert.equal(f.dependencies.stateSyncClients.size, 0);
    assert.deepEqual(f.cleared, f.timers);
  }
});

test("state initialization failure returns JSON before opening a stream", () => {
  const f = fixture();
  f.dependencies.stateSyncService.changesAfter = () => ({ snapshotRequired: true });
  f.dependencies.stateSyncService.snapshot = () => { throw new Error("not ready"); };
  const { response } = f.dispatch("/state/events");
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "STATE_SNAPSHOT_FAILED");
  assert.equal(response.headers, undefined);
  assert.equal(f.dependencies.stateSyncClients.size, 0);
  assert.deepEqual(f.timers, []);
});

test("diagnostics remain opt-in and snapshot-required changes retain HTTP 410", () => {
  const f = fixture();
  assert.equal(f.dispatch("/state/snapshot").response.body.revision, 10);
  assert.equal(f.dispatch("/state/diagnostics").response.body.terminalTimelines, undefined);
  const selected = f.dispatch("/state/diagnostics?sessionId=session").response.body;
  assert.equal(selected.replayDepth, 7);
  assert.equal(selected.healthy, true);
  assert.deepEqual(selected.terminalTimelines, [{ id: "session" }]);
  assert.deepEqual(f.dispatch("/state/diagnostics?includeTimelines=1").response.body.terminalTimelines, [{ id: "all" }]);
  f.dependencies.stateSyncService.changesAfter = () => ({ snapshotRequired: true });
  assert.equal(f.dispatch("/state/changes").response.status, 410);
  assert.deepEqual(f.dispatch("/diagnostics/sqlite-queries?limit=20").response.body, { limit: "20" });
  assert.equal(f.dispatch("/state/events", "POST").handled, false);
  assert.equal(f.dispatch("/other").handled, false);
});
