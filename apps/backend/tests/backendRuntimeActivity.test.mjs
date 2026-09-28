import test from "node:test";
import assert from "node:assert/strict";
import { BackendRuntimeActivity } from "../src/application/backendRuntimeActivity.mjs";

test("runtime timers are idempotent and stop releases both handles", () => {
  const activity = new BackendRuntimeActivity({
    emitEvent() {}, tickAgentWorkQueue: async () => {}, updateMockProgress() {}
  });
  try {
    activity.startQueueTimer();
    activity.startMockTimer();
    const queue = activity.queueTimer;
    const mock = activity.mockTimer;
    activity.startQueueTimer();
    activity.startMockTimer();
    assert.equal(activity.queueTimer, queue);
    assert.equal(activity.mockTimer, mock);
  } finally {
    activity.stopTimers();
  }
  assert.equal(activity.queueTimer, null);
  assert.equal(activity.mockTimer, null);
});

test("maintenance wait contains rejection and releases settled task ownership", async () => {
  const activity = new BackendRuntimeActivity({});
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const failed = Promise.reject(new Error("failure"));
  assert.equal(activity.trackMaintenance(pending), pending);
  activity.trackMaintenance(failed);
  const waiting = activity.waitForMaintenance();
  finish("done");
  const results = await waiting;
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal(activity.maintenance.size, 0);
});
