import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { handleSessionTimelineHttpRequest } from "../src/application/sessionTimelineHttpApi.mjs";

function fixture() {
  const calls = [];
  let published = 0;
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return value; };
  const dependencies = {
    store: {
      listSessions: record("sessions", [
        { id: "stored", sessionKind: "workChat" },
        { id: "legacy", sessionKind: "unknown" }
      ]),
      listSessionTimelineRevisions: record("revisions", new Map([["stored", 7]])),
      getSession: record("session", { id: "stored" }),
      listSessionEventPage: record("page", [{ sequence: 5 }, { sequence: 6 }]),
      listSessionEvents: record("events", [{ sequence: 6 }]),
      lastSessionEventSequence: () => 6,
      markSessionMessagesRead: record("read", { throughSequence: 6 })
    },
    sessionApplicationService: { referenceFor: async (id) => {
      calls.push(["reference", id]);
      return { sessionId: "stored", logicalSessionId: "logical" };
    } },
    getStoredSessionSnapshot: async () => ({ id: "stored", timelineRevision: 7 }),
    getTimelineReadPool: () => ({ readTimelineChanges: record("changes", Promise.resolve({ snapshotRequired: false })) }),
    readSessionUsage: async () => ({ tokens: 5 }),
    readSessionHistory: record("history", Promise.resolve({ items: [] })),
    readSessionTimelineWindow: record("window", Promise.resolve({ items: [] })),
    publishStateChangesIfNeeded: () => { published += 1; },
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    unifiedErrorStatus: (error) => error.statusCode ?? 400
  };
  function dispatch(path, method = "GET", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const handled = handleSessionTimelineHttpRequest({ ...dependencies,
      request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") });
    return { handled, result };
  }
  return { calls, dependencies, dispatch, published: () => published };
}

test("timeline revisions and snapshots retain response envelopes", async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch("/session-timelines/revisions").result,
    { status: 200, body: { sessions: [{ sessionId: "stored", timelineRevision: 7 }] } });
  assert.deepEqual(f.calls, [["sessions", { archived: false }], ["revisions", ["stored"]]]);
  assert.deepEqual(await f.dispatch("/sessions/public/stored-snapshot").result,
    { status: 200, body: { timelineRevision: 7, session: { id: "stored", timelineRevision: 7 } } });
});

test("incremental timeline reads resolve stable identity and retain snapshot-required status", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/sessions/public%2Fid/timeline/changes?after=12&limit=25").result).status, 200);
  assert.deepEqual(f.calls, [["reference", "public/id"], ["changes", { sessionId: "stored", after: 12, limit: 25 }]]);
  f.dependencies.getTimelineReadPool = () => ({ readTimelineChanges: async () => ({ snapshotRequired: true }) });
  assert.equal((await f.dispatch("/sessions/public/timeline/changes").result).status, 410);
});

test("events preserve historical and incremental cursor selection", async () => {
  const f = fixture();
  const page = await f.dispatch("/sessions/public/events?limit=2").result;
  assert.equal(page.body.sessionId, "logical");
  assert.equal(page.body.legacySessionId, "stored");
  assert.equal(page.body.beforeSequence, 5);
  assert.equal(page.body.hasMoreHistory, true);
  assert.deepEqual(f.calls[1], ["page", "stored", { beforeSequence: null, limit: 2 }]);
  assert.equal((await f.dispatch("/sessions/public/events?after=5&limit=2").result).body.hasMoreHistory, false);
  assert.deepEqual(f.calls[3], ["events", "stored", 5, 2]);
  await f.dispatch("/sessions/public/events?after=5&beforeSequence=8&limit=2").result;
  assert.deepEqual(f.calls[5], ["page", "stored", { beforeSequence: "8", limit: 2 }]);
});

test("history and anchor windows retain bounded page sizes and defaults", async () => {
  const f = fixture();
  await f.dispatch("/sessions/public%2Fid/history?before=cursor&limit=99999").result;
  assert.deepEqual(f.calls[0], ["history", "public/id", "cursor", 200]);
  await f.dispatch("/sessions/public/timeline/window?anchorKind=turn&anchor=turn-id&before=2.8&after=9999&limit=invalid").result;
  assert.deepEqual(f.calls[1], ["window", "public", { anchorKind: "turn", anchorId: "turn-id", before: 2, after: 200, limit: 200 }]);
  await f.dispatch("/sessions/public/timeline/window").result;
  assert.deepEqual(f.calls[2], ["window", "public", { anchorKind: "item", anchorId: null, before: 40, after: 40, limit: 200 }]);
});

test("read receipts commit before deferred state publishing and failures do not publish", async () => {
  const f = fixture();
  const result = await f.dispatch("/sessions/public/read-receipt", "POST", { throughSequence: 6 }).result;
  assert.deepEqual(f.calls[1], ["read", "stored", 6]);
  assert.deepEqual(result, { status: 200, body: { sessionId: "logical", legacySessionId: "stored", throughSequence: 6 } });
  assert.equal(f.published(), 0);
  await nextImmediate();
  assert.equal(f.published(), 1);
  f.dependencies.store.markSessionMessagesRead = () => { throw Object.assign(new Error("conflict"), { code: "CONFLICT", statusCode: 409 }); };
  assert.equal((await f.dispatch("/sessions/public/read-receipt", "POST").result).status, 409);
  await nextImmediate();
  assert.equal(f.published(), 1);
});

test("usage failures and unmatched methods preserve existing contracts", async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch("/sessions/public/usage").result, { status: 200, body: { tokens: 5 } });
  f.dependencies.readSessionUsage = async () => { throw new Error("unavailable"); };
  assert.equal((await f.dispatch("/sessions/public/usage").result).status, 503);
  f.dependencies.store.getSession = () => null;
  assert.equal((await f.dispatch("/sessions/public/usage").result).status, 404);
  assert.equal(f.dispatch("/sessions/public/history", "POST").handled, false);
  assert.equal(f.dispatch("/other").handled, false);
});
