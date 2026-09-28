import assert from "node:assert/strict";
import test from "node:test";
import { createTimelineChangeDispatcher } from "../src/application/timelineChangeDispatcher.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const dispatcher = createTimelineChangeDispatcher({
    store: {
      getLogicalSession: () => null,
      getLogicalSessionByLegacySessionId: () => null,
      getSession: () => null
    },
    resolveSessionReference: () => ({
      sessionId: "session:stored", logicalSessionId: "logical:bound",
      requestedSessionId: "public", metadata: { session: { taskId: "task:one" } }
    }),
    invalidateDevices: (value) => calls.push(["invalidate", value]),
    publishDeviceTimeline: (id) => calls.push(["publish", id]),
    scheduleTimelineChange: (value) => calls.push(["schedule", value]),
    ...overrides
  });
  return { calls, dispatcher };
}

test("legacy aliases include resolved product identities without duplicate entries", () => {
  const f = fixture();
  const aliases = f.dispatcher.resolveTimelineChangeSessionAliases("codex:original");
  for (const id of ["codex:original", "original", "session:original", "logical:original",
    "session:stored", "stored", "logical:bound", "bound", "public", "task:one"]) {
    assert.ok(aliases.includes(id), id);
  }
  assert.equal(new Set(aliases).size, aliases.length);
});

test("route lookup failures retain best-effort lexical aliases", () => {
  const f = fixture({ resolveSessionReference: () => { throw new Error("not ready"); } });
  assert.deepEqual(f.dispatcher.resolveTimelineChangeSessionAliases("session:one"), [
    "session:one", "one", "codex:one", "logical:one"
  ]);
  assert.deepEqual(f.dispatcher.resolveTimelineChangeSessionAliases(null), []);
});

test("canonical timeline publication occurs once regardless of legacy alias count", () => {
  const f = fixture();
  const change = { sessionId: "codex:original", timelineRevision: 7 };
  f.dispatcher.scheduleTimelineChangePublish(change);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["invalidate", "publish", "schedule"]);
  assert.ok(f.calls[0][1].sessionIds.length > 1);
  assert.deepEqual(f.calls[1], ["publish", "codex:original"]);
  assert.deepEqual(f.calls[2], ["schedule", change]);
});
