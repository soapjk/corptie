import assert from "node:assert/strict";
import test from "node:test";
import { SessionRuntimeReleaseService } from "../src/application/sessionRuntimeReleaseService.mjs";

test("archived Session runtime release waits for unsettled work and preserves persistence", async () => {
  let busy = true;
  const scheduled = [];
  const calls = [];
  const session = { id: "session:worker", archived: true, taskId: "task:one" };
  const service = new SessionRuntimeReleaseService({
    store: {
      getSession: () => session,
      listSessions: () => [session],
      hasUnsettledSessionRuntimeWork: () => busy
    },
    sessionService: {
      disconnectSession: async (...args) => {
        calls.push(args);
        return { status: "disconnected" };
      }
    },
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { unref() {} };
    },
    cancel: () => {},
    logger: { warn() {} }
  });

  const release = service.request(session.id, "task-completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal(scheduled.length, 1);

  busy = false;
  scheduled.shift().callback();
  assert.deepEqual(await release, { status: "released", result: { status: "disconnected" } });
  assert.deepEqual(calls, [[session.id, {
    source: "session-archive-runtime-release",
    reason: "task-completed"
  }]]);
});

test("unarchiving cancels a pending runtime release", async () => {
  const scheduled = [];
  const service = new SessionRuntimeReleaseService({
    store: {
      getSession: () => ({ id: "session:assistant", archived: true }),
      listSessions: () => [],
      hasUnsettledSessionRuntimeWork: () => true
    },
    sessionService: { disconnectSession: async () => assert.fail("must not disconnect") },
    schedule: (callback) => {
      const timer = { callback, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => scheduled.splice(scheduled.indexOf(timer), 1),
    logger: { warn() {} }
  });

  const release = service.request("session:assistant", "manual-archive");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.cancelPending("session:assistant"), true);
  assert.deepEqual(await release, { status: "cancelled", reason: "session_unarchived" });
  assert.equal(scheduled.length, 0);
});

test("completed Task and startup reconciliation select only archived Sessions", () => {
  const requested = [];
  const sessions = [
    { id: "session:worker", archived: true, archiveReason: "taskCompleted", taskId: "task:one" },
    { id: "session:manual", archived: true, archiveReason: "manual", taskId: null }
  ];
  const service = new SessionRuntimeReleaseService({
    store: {
      getSession: () => null,
      listSessions: () => sessions,
      hasUnsettledSessionRuntimeWork: () => false
    },
    sessionService: { disconnectSession: async () => ({}) },
    logger: { warn() {} }
  });
  service.request = (id, reason) => { requested.push([id, reason]); return Promise.resolve(); };

  assert.equal(service.releaseCompletedTaskSessions("task:one"), 1);
  assert.equal(service.reconcileArchivedSessions(), 2);
  assert.deepEqual(requested, [
    ["session:worker", "task-completed"],
    ["session:worker", "taskCompleted"],
    ["session:manual", "manual"]
  ]);
});

test("restoring an archived Session reconnects its persisted Provider binding", async () => {
  const calls = [];
  const service = new SessionRuntimeReleaseService({
    store: { listSessions: () => [], getSession: () => null, hasUnsettledSessionRuntimeWork: () => false },
    sessionService: {
      resumeSession: async (...args) => { calls.push(args); return { id: "session:assistant" }; }
    }
  });

  assert.deepEqual(await service.restore("session:assistant"), { id: "session:assistant" });
  assert.deepEqual(calls, [["session:assistant", {
    source: "session-unarchive-runtime-restore",
    purpose: "session-unarchive"
  }]]);
});
