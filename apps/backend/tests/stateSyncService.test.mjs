import assert from "node:assert/strict";
import test from "node:test";
import { StateSyncService } from "../src/application/stateSyncService.mjs";

function fixture({ revision = 0, oldest = revision, changes = [], state = {} } = {}) {
  const store = {
    stateRevision: () => revision,
    oldestStateChangeRevision: () => oldest,
    stateChangesAfter: (after) => changes.filter((change) => change.revision > after)
  };
  return new StateSyncService({ store, snapshot: () => state });
}

test("state snapshot normalizes every control-plane collection", () => {
  const service = fixture({ revision: 4, state: { sessions: [{ id: "s1" }] } });
  const snapshot = service.snapshot();
  assert.equal(snapshot.revision, 4);
  assert.deepEqual(snapshot.state.sessions, [{ id: "s1" }]);
  assert.deepEqual(snapshot.state.workItems, []);
  assert.deepEqual(snapshot.state.integrationRuns, []);
});

test("change set coalesces row history and hydrates authoritative entities", () => {
  const service = fixture({
    revision: 3,
    oldest: 1,
    changes: [
      { revision: 2, entityType: "session", entityId: "s1", operation: "upsert" },
      { revision: 3, entityType: "workItem", entityId: "w1", operation: "upsert" }
    ],
    state: { sessions: [{ id: "s1", status: "running" }], workItems: [{ id: "w1" }] }
  });
  const changes = service.changesAfter(1);
  assert.equal(changes.snapshotRequired, false);
  assert.equal(changes.revision, 3);
  assert.deepEqual(changes.upserts.sessions, [{ id: "s1", status: "running" }]);
  assert.deepEqual(changes.upserts.workItems, [{ id: "w1" }]);
});

test("change set emits deletes and requires snapshot beyond replay window", () => {
  const service = fixture({
    revision: 8,
    oldest: 8,
    changes: [{ revision: 8, entityType: "session", entityId: "gone", operation: "delete" }]
  });
  assert.equal(service.changesAfter(1).snapshotRequired, true);
  const changes = service.changesAfter(7);
  assert.deepEqual(changes.deletes.sessions, ["gone"]);
});

test("upsert missing from provider-memory snapshot is skipped, not deleted", () => {
  // operation='upsert' means the row still exists in the database (INSERT/UPDATE
  // trigger). A missing snapshot projection (e.g. an OpenClacky session whose
  // in-memory cache briefly dropped it) must not be misreported as a delete.
  const service = fixture({
    revision: 3,
    oldest: 2,
    changes: [{ revision: 3, entityType: "session", entityId: "s-missing", operation: "upsert" }],
    state: { sessions: [], workItems: [] }
  });
  const changes = service.changesAfter(2);
  assert.equal(changes.snapshotRequired, false);
  assert.deepEqual(changes.deletes.sessions, []);
  assert.deepEqual(changes.upserts.sessions, []);
});
