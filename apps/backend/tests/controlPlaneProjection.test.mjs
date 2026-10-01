import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneProjection } from "../src/application/controlPlaneProjection.mjs";

function fixture() {
  const reads = [];
  const session = { id: "session:one", sessionKind: "assistantChat", archived: false };
  const task = { id: "task:one", lifecycle_state: "active" };
  const store = {
    listSessions: (options) => { reads.push(["sessions", options]); return [session]; },
    getSession: () => session,
    listLatestSessionMessageTimes: (ids) => {
      reads.push(["times", ids]); return new Map([[session.id, "2026-01-02T00:00:00Z"]]);
    },
    listSessionMessageCursors: (ids) => {
      reads.push(["cursors", ids]); return new Map([[session.id, { lastAgentMessageSequence: 7, lastReadMessageSequence: 3 }]]);
    },
    listSessionTimelineRevisions: (ids) => {
      reads.push(["revisions", ids]); return new Map([[session.id, 9]]);
    },
    sessionTimelineRevision: () => 9,
    listTasks: (options) => { reads.push(["tasks", options]); return [task]; },
    getTask: () => task,
    listTaskIdsWithPendingScheduledWake: () => [task.id],
    hasPendingScheduledWakeForTask: () => true,
    listSessionIdsWithPendingScheduledWake: () => [session.id],
    listWorks: () => [],
    listAgents: () => [],
    listRegistrySkills: () => [],
    listGitRepositories: () => [],
    listProjectIntegrationRuns: () => []
  };
  const projection = createControlPlaneProjection({
    store, environmentName: "development",
    decorateSessionForClient: (value) => ({ ...value, decorated: true })
  });
  return { projection, reads, session, task };
}

test("snapshot requests active residents and bulk-loads each message projection once", () => {
  const f = fixture();
  const snapshot = f.projection.controlPlaneSnapshot();
  assert.deepEqual(f.reads, [
    ["sessions", { archived: false }],
    ["times", ["session:one"]], ["cursors", ["session:one"]],
    ["revisions", ["session:one"]], ["tasks", { includeCompleted: false }]
  ]);
  assert.equal(snapshot.sessions[0].decorated, true);
  assert.equal(snapshot.sessions[0].hasPendingScheduledWake, true);
  assert.equal(snapshot.sessions[0].lastAgentMessageSequence, 7);
  assert.equal(snapshot.sessions[0].lastReadMessageSequence, 3);
  assert.equal(snapshot.sessions[0].timelineRevision, 9);
  assert.equal(snapshot.tasks[0].hasPendingScheduledWake, true);
});

test("snapshot and incremental session reads use the same projection", () => {
  const f = fixture();
  const snapshot = f.projection.controlPlaneSnapshot();
  assert.deepEqual(f.projection.readControlPlaneEntity("session", f.session.id), snapshot.sessions[0]);
  assert.deepEqual(f.projection.readControlPlaneEntity("task", f.task.id), snapshot.tasks[0]);
});

test("streamed Provider output cannot outrank the durable conversation activity time", () => {
  const f = fixture();
  f.session.lastOutputAt = "2026-12-01T00:00:00Z";
  f.session.rawStatus = { lastMessageAt: "2026-12-02T00:00:00Z" };
  const snapshot = f.projection.controlPlaneSnapshot();
  assert.equal(snapshot.sessions[0].lastMessageAt, "2026-01-02T00:00:00Z");
});

test("archived sessions and completed tasks leave the resident incremental projection", () => {
  const f = fixture();
  f.session.archived = true;
  f.task.lifecycle_state = "done";
  assert.equal(f.projection.readControlPlaneEntity("session", f.session.id), null);
  assert.equal(f.projection.readControlPlaneEntity("task", f.task.id), null);
  assert.equal(f.projection.readControlPlaneEntity("unknown", "one"), null);
  assert.deepEqual(f.reads, []);
});
