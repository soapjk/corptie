import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { parseJson } from "../src/store/storedJson.mjs";

test("stored JSON retains null and uses the caller fallback only for invalid JSON", () => {
  const fallback = {};
  assert.equal(parseJson("null", fallback), null);
  assert.equal(parseJson("invalid", fallback), fallback);
  assert.deepEqual(parseJson('{"count":1}', fallback), { count: 1 });
});

test("Automation writes and lease claims participate in the Store transaction", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-automation-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const input = {
      taskId: "automation:transaction", logicalSessionId: "logical:test",
      message: { text: "check" }, scheduleType: "once", timezone: "UTC",
      missedPolicy: "coalesce_once", creatorType: "session", creatorId: "logical:test",
      environment: "development", createdAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z"
    };
    const failure = new Error("rollback");
    assert.throws(() => store.runInTransaction(() => {
      store.createScheduledSessionTask(input);
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getScheduledSessionTask(input.taskId), null);
    assert.equal(notifications, 0);
    store.runInTransaction(() => {
      store.createScheduledSessionTask(input);
      store.updateScheduledSessionTask(input.taskId, { name: "committed" });
      assert.equal(notifications, 0);
    });
    assert.equal(notifications, 1);
    const claim = {
      environment: "development", now: "2026-02-01T00:00:00.000Z",
      leaseUntil: "2026-02-01T00:01:00.000Z", leaseOwner: "worker"
    };
    assert.throws(() => store.runInTransaction(() => {
      assert.equal(store.claimDueScheduledSessionTasks(claim).length, 1);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getScheduledSessionTask(input.taskId).leaseOwner, null);
    assert.equal(store.claimDueScheduledSessionTasks(claim).length, 1);
    assert.equal(store.claimDueScheduledSessionTasks(claim).length, 0);
  } finally {
    await store.close();
  }
});
