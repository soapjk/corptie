import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionCollectionPatch,
  SessionCollectionRevisionBuffer,
  sessionCollectionPatchIsEmpty
} from "../src/utils/sessionCollectionDelta.mjs";

const session = (id, overrides = {}) => ({
  id,
  title: id,
  summary: "ready",
  status: "ready",
  updatedAt: "2026-08-12T00:00:00.000Z",
  external: { provider: "test-provider", cwd: `/tmp/${id}` },
  ...overrides
});

test("content-only patch does not publish an ordered id replacement", () => {
  const patch = createSessionCollectionPatch(
    [session("a"), session("b")],
    [session("a", { summary: "working" }), session("b")],
    { baseRevision: 4, revision: 5 }
  );
  assert.equal(patch.orderedIds, null);
  assert.deepEqual(patch.updated.map((item) => item.sessionId), ["a"]);
  assert.ok(patch.updated[0].changedFields.includes("summary"));
});

test("structural patch carries canonical order, insertions and removals", () => {
  const patch = createSessionCollectionPatch(
    [session("a"), session("b")],
    [session("b"), session("c")],
    { baseRevision: 7, revision: 8 }
  );
  assert.deepEqual(patch.orderedIds, ["b", "c"]);
  assert.deepEqual(patch.removedIds, ["a"]);
  assert.deepEqual(patch.inserted.map((item) => item.session.id), ["c"]);
});

test("revision buffer replays contiguous patches and snapshots stale cursors", () => {
  const buffer = new SessionCollectionRevisionBuffer({ historyLimit: 2 });
  buffer.update([session("a")]);
  buffer.update([session("a", { status: "running" })]);
  buffer.update([session("a", { status: "completed" })]);

  assert.deepEqual(buffer.framesAfter(2).map((frame) => frame.name), ["session-collection-patch"]);
  assert.deepEqual(buffer.framesAfter(0).map((frame) => frame.name), ["session-collection-snapshot"]);
  assert.equal(sessionCollectionPatchIsEmpty(createSessionCollectionPatch(
    buffer.sessions,
    buffer.sessions,
    { baseRevision: 3, revision: 4 }
  )), true);
});

test("revision buffer is isolated from Provider-owned mutable session objects", () => {
  const source = session("mutable");
  const buffer = new SessionCollectionRevisionBuffer();
  buffer.update([source]);
  source.summary = "changed in place";
  const patch = buffer.update([source]);
  assert.equal(patch.updated[0].session.summary, "changed in place");
  assert.ok(patch.updated[0].changedFields.includes("summary"));
});
