import test from "node:test";
import assert from "node:assert/strict";
import { StoreTransactionCoordinator } from "../src/store/storeTransactionCoordinator.mjs";

function fixture() {
  const events = [];
  const coordinator = new StoreTransactionCoordinator({
    readDatabase: () => ({ run: (sql) => events.push(sql) }),
    sessionTimelineRevision: () => 7
  });
  coordinator.setStateDirtyListener(() => events.push("state"));
  coordinator.setTimelineDirtyListener((value) => events.push(value));
  return { coordinator, events };
}

test("nested writes share one commit and coalesce notifications after commit", () => {
  const { coordinator, events } = fixture();
  assert.equal(coordinator.runInTransaction(() => {
    coordinator.scheduleSave();
    coordinator.notifyTimelineDirty("session");
    return coordinator.runInTransaction(() => {
      coordinator.scheduleSave();
      coordinator.notifyTimelineDirty("session");
      assert.deepEqual(events, ["BEGIN IMMEDIATE"]);
      return 42;
    });
  }), 42);
  assert.deepEqual(events, ["BEGIN IMMEDIATE", "COMMIT", "state", { sessionId: "session", revision: 7 }]);
});

test("rollback discards queued notifications and permits another transaction", () => {
  const { coordinator, events } = fixture();
  assert.throws(() => coordinator.runInTransaction(() => {
    coordinator.scheduleSave();
    coordinator.notifyTimelineDirty("session");
    throw new Error("rollback");
  }), /rollback/);
  coordinator.runInTransaction(() => {});
  assert.deepEqual(events, ["BEGIN IMMEDIATE", "ROLLBACK", "BEGIN IMMEDIATE", "COMMIT"]);
});

test("listener failure after commit never causes a rollback", () => {
  const { coordinator, events } = fixture();
  coordinator.setStateDirtyListener(() => { throw new Error("listener failed"); });
  assert.doesNotThrow(() => coordinator.runInTransaction(() => {
    coordinator.scheduleSave();
    coordinator.notifyTimelineDirty("session");
  }));
  assert.deepEqual(events, ["BEGIN IMMEDIATE", "COMMIT", { sessionId: "session", revision: 7 }]);
});
