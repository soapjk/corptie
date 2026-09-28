import assert from "node:assert/strict";
import test from "node:test";
import { createSessionTimelineReader } from "../src/application/sessionTimelineReader.mjs";

function fixture() {
  const calls = [];
  const pools = [];
  const session = { id: "stored", title: "Current", status: "idle", external: { provider: "test-provider" } };
  const reference = { sessionId: "stored", logicalSessionId: "logical", metadata: { session } };
  const window = { items: [{ id: "item" }], hasEarlier: true, historyItemsCount: 5 };
  const result = { window, timelineRevision: 9, lastEventSequence: 12, lastAgentMessageSequence: 7 };
  const reader = createSessionTimelineReader({
    store: {
      dbPath: "/data/store.db", configPath: "/data/config", dataRoot: "/data",
      getDetail: (_id, options) => { calls.push(["detail", options]); return { title: "Old", cwd: "/project" }; },
      getSession: () => session
    },
    requireSessionReference: (id) => { calls.push(["resolve", id]); return reference; },
    decorateSessionForClient: (value) => ({ ...value, decorated: true }),
    createReadPool: (options) => {
      calls.push(["pool", options]);
      const pool = {
        readStoredTimelineSnapshot: async (input) => { calls.push(["snapshot", input]); return result; },
        readTimelineHistoryPage: async (input) => { calls.push(["history", input]); return { items: window.items }; },
        readTimelineWindow: async (input) => { calls.push(["window", input]); return result; },
        close: async () => calls.push(["close"])
      };
      pools.push(pool);
      return pool;
    }
  });
  return { calls, pools, reader, result, reference };
}

test("pool creation is lazy, reused and recreated after close", async () => {
  const f = fixture();
  assert.equal(f.pools.length, 0);
  const first = f.reader.getTimelineReadPool();
  assert.equal(f.reader.getTimelineReadPool(), first);
  await f.reader.closeTimelineReadPool();
  assert.notEqual(f.reader.getTimelineReadPool(), first);
  assert.equal(f.pools.length, 2);
  assert.equal(f.calls.filter(([name]) => name === "close").length, 1);
});

test("snapshot combines stored metadata and current summary with the materialized timeline", async () => {
  const f = fixture();
  const snapshot = await f.reader.getStoredSessionSnapshot("public");
  assert.equal(snapshot.title, "Current");
  assert.equal(snapshot.sessionId, "stored");
  assert.equal(snapshot.publicSessionId, "logical");
  assert.equal(snapshot.decorated, true);
  assert.equal(snapshot.hasMoreHistory, true);
  assert.equal(snapshot.timelineRevision, 9);
  assert.deepEqual(snapshot.items, [{ id: "item" }]);
  assert.deepEqual(f.calls.find(([name]) => name === "detail"), ["detail", { includeItems: false }]);
  assert.equal(f.calls.find(([name]) => name === "snapshot")[1].provider, "test-provider");
});

test("history delegates keyset boundaries to the pool using the resolved stored identity", async () => {
  const f = fixture();
  const page = await f.reader.readSessionHistory("public", "before", 25);
  assert.deepEqual(f.calls.find(([name]) => name === "history"), ["history", {
    sessionId: "stored", beforeId: "before", limit: 25, provider: "test-provider"
  }]);
  assert.equal(page.logicalSessionId, "logical");
});

test("window responses preserve found, latest and missing anchor semantics", async () => {
  const f = fixture();
  const latest = await f.reader.readSessionTimelineWindow("public", {});
  assert.deepEqual(latest.anchor, { kind: "latest", requestedId: null, resolvedId: "item", status: "latest" });
  const found = await f.reader.readSessionTimelineWindow("public", { anchorId: "item", anchorKind: "item" });
  assert.equal(found.anchor.status, "found");
  f.result.window = null;
  const missing = await f.reader.readSessionTimelineWindow("public", { anchorId: "turn", anchorKind: "turn" });
  assert.deepEqual(missing.anchor, { kind: "turn", requestedId: "turn", resolvedId: null, status: "missing" });
  assert.deepEqual(missing.items, []);
  assert.equal(missing.revision, 9);
});
