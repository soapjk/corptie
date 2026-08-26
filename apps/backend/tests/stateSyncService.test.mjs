import assert from "node:assert/strict";
import test from "node:test";
import { deliveredStateRevision, StateSyncService } from "../src/application/stateSyncService.mjs";

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
  assert.deepEqual(snapshot.state.skills, []);
  assert.deepEqual(snapshot.state.integrationRuns, []);
});

test("state snapshot retries until payload and revision are one immutable state", () => {
  let revision = 4;
  let projections = 0;
  const store = {
    stateRevision: () => revision,
    oldestStateChangeRevision: () => revision,
    stateChangesAfter: () => []
  };
  const service = new StateSyncService({
    store,
    snapshot: () => {
      projections += 1;
      if (projections === 1) {
        revision = 5;
        return { sessions: [{ id: "session", status: "running" }] };
      }
      return { sessions: [{ id: "session", status: "complete" }] };
    }
  });

  const snapshot = service.snapshot();
  assert.equal(snapshot.revision, 5);
  assert.deepEqual(snapshot.state.sessions, [{ id: "session", status: "complete" }]);
  assert.equal(projections, 2);
  assert.equal(service.diagnostics().snapshotBuilds, 1);
});

test("state snapshot refuses to publish when no stable revision can be read", () => {
  let revision = 1;
  const service = new StateSyncService({
    store: {
      stateRevision: () => revision,
      oldestStateChangeRevision: () => revision,
      stateChangesAfter: () => []
    },
    snapshot: () => {
      revision += 1;
      return { sessions: [{ id: "session", status: "running" }] };
    }
  });

  assert.throws(() => service.snapshot(), { code: "STATE_SNAPSHOT_UNSTABLE" });
  assert.equal(service.diagnostics().snapshotBuilds, 0);
});

test("Skill deletes and assignment-driven Agent upserts share the revision stream", () => {
  const service = fixture({
    revision: 4,
    oldest: 2,
    changes: [
      { revision: 3, entityType: "skill", entityId: "skill:one", operation: "delete" },
      { revision: 4, entityType: "agent", entityId: "agent:one", operation: "upsert" }
    ],
    state: { agents: [{ agentId: "agent:one", skillIds: [] }], skills: [] }
  });
  const changes = service.changesAfter(2);
  assert.deepEqual(changes.deletes.skills, ["skill:one"]);
  assert.deepEqual(changes.upserts.agents, [{ agentId: "agent:one", skillIds: [] }]);
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

test("clients at different revisions receive independent catch-up ranges", () => {
  const service = fixture({
    revision: 11,
    oldest: 9,
    changes: [
      { revision: 9, entityType: "session", entityId: "s1", operation: "upsert" },
      { revision: 10, entityType: "session", entityId: "s2", operation: "upsert" },
      { revision: 11, entityType: "session", entityId: "s1", operation: "upsert" }
    ],
    state: {
      sessions: [
        { id: "s1", status: "complete", lastAgentMessageSequence: 7 },
        { id: "s2", status: "running", lastAgentMessageSequence: 0 }
      ]
    }
  });

  const existingClient = service.changesAfter(10);
  const newlyConnectedClient = service.changesAfter(11);

  assert.equal(existingClient.baseRevision, 10);
  assert.equal(existingClient.revision, 11);
  assert.deepEqual(existingClient.upserts.sessions, [
    { id: "s1", status: "complete", lastAgentMessageSequence: 7 }
  ]);
  assert.equal(newlyConnectedClient.baseRevision, 11);
  assert.equal(newlyConnectedClient.revision, 11);
  assert.deepEqual(newlyConnectedClient.upserts.sessions, []);
});

test("entity absent from the authoritative projection removes a stale client copy", () => {
  const service = fixture({
    revision: 3,
    oldest: 2,
    changes: [{ revision: 3, entityType: "session", entityId: "s-missing", operation: "upsert" }],
    state: { sessions: [], workItems: [] }
  });
  const changes = service.changesAfter(2);
  assert.equal(changes.snapshotRequired, false);
  assert.deepEqual(changes.deletes.sessions, ["s-missing"]);
  assert.deepEqual(changes.upserts.sessions, []);
});

test("state sync builds one shared snapshot per revision", () => {
  let revision = 9;
  let projections = 0;
  let changeQueries = 0;
  const store = {
    stateRevision: () => revision,
    oldestStateChangeRevision: () => 9,
    stateChangesAfter: () => {
      changeQueries += 1;
      return [{ revision, entityType: "session", entityId: "s1", operation: "upsert" }];
    }
  };
  const service = new StateSyncService({
    store,
    snapshot: () => {
      projections += 1;
      return { sessions: [{ id: "s1", status: "running" }] };
    }
  });

  const firstClient = service.snapshot();
  const secondClient = service.snapshot();
  assert.equal(firstClient, secondClient, "new clients share the immutable wire snapshot");
  assert.equal(projections, 1);

  assert.deepEqual(service.changesAfter(9).upserts.sessions, []);
  assert.equal(changeQueries, 0, "unchanged revisions never query entities or the replay log");

  revision = 10;
  service.changesAfter(9);
  service.changesAfter(9);
  assert.equal(projections, 2, "all clients targeting revision 10 reuse one projection");
  assert.equal(service.diagnostics().snapshotBuilds, 2);
});

test("SSE delivery cursor acknowledges the serialized frame instead of a newer Store revision", () => {
  const snapshot = { revision: 41, state: { sessions: [{ id: "session", status: "running" }] } };
  const snapshotRequired = { snapshotRequired: true, currentRevision: 41 };
  // A terminal commit can advance the Store to 42 immediately after this
  // snapshot is built. The connection must remain at 41 so revision 42 is sent.
  assert.equal(deliveredStateRevision(snapshotRequired, snapshot), 41);
  assert.equal(deliveredStateRevision({ snapshotRequired: false, revision: 42 }), 42);
  assert.throws(
    () => deliveredStateRevision({ snapshotRequired: true }, null),
    { code: "STATE_DELIVERY_REVISION_INVALID" }
  );
});
