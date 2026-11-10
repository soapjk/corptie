import test from "node:test";
import assert from "node:assert/strict";
import { FeishuSyncScheduler } from "../src/feishu/feishuSyncScheduler.mjs";

test("concurrent sync requests coalesce into one follow-up pass", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const scheduler = new FeishuSyncScheduler({
    store: {}, requestSync: () => {},
    syncBotOnce: async () => { count += 1; if (count === 1) await pending; }
  });
  const first = scheduler.syncBot("bot");
  await Promise.resolve();
  const second = scheduler.syncBot("bot");
  const third = scheduler.syncBot("bot");
  assert.equal(count, 1);
  release();
  await Promise.all([first, second, third]);
  assert.equal(count, 2);
  assert.equal(scheduler.syncRuns.size, 0);
});

test("event debounce updates the cursor and close cancels pending timers", () => {
  const timers = new Set();
  const intervals = new Set();
  const cursors = [];
  const scheduler = new FeishuSyncScheduler({
    store: {
      getFeishuAssignmentForSession: () => ({ botId: "bot" }),
      getFeishuBot: () => ({ enabled: true }),
      updateFeishuAssignmentCursor: (...args) => cursors.push(args)
    },
    syncBotOnce: async () => {}, requestSync: async () => {},
    scheduleTimeout: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; },
    cancelTimeout: (timer) => timers.delete(timer),
    scheduleInterval: (callback, delay) => { const timer = { callback, delay }; intervals.add(timer); return timer; },
    cancelInterval: (timer) => intervals.delete(timer)
  });
  scheduler.start();
  scheduler.handleSessionEvent({ sessionId: "session", sequence: 1 });
  scheduler.handleSessionEvent({ sessionId: "session", sequence: 2 });
  assert.equal(timers.size, 1);
  assert.equal([...timers][0].delay, 500);
  assert.equal([...intervals][0].delay, 2000);
  assert.deepEqual(cursors, [["bot", 1], ["bot", 2]]);
  scheduler.close();
  assert.equal(timers.size, 0);
  assert.equal(intervals.size, 0);
});

test("identical sync failures back off per bot and are logged only once", async () => {
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  try {
    let calls = 0;
    let fail = true;
    const scheduler = new FeishuSyncScheduler({
      store: {
        listFeishuAssignments: () => [{ botId: "bot" }],
        getFeishuBot: () => ({ enabled: true })
      },
      syncBotOnce: async () => {},
      requestSync: async () => {
        calls += 1;
        if (fail) throw new Error("Feishu API 230099: card table number over limit");
      }
    });

    await scheduler.runPeriodicSync("bot");
    assert.equal(calls, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /backoff 2000ms/);

    // Still inside the backoff window: no replay and no duplicate log line.
    await scheduler.runPeriodicSync("bot");
    assert.equal(calls, 1);
    assert.equal(logs.length, 1);

    // A distinct failure is worth one more line; a success resets the state.
    scheduler.failureState.get("bot").nextAllowedAt = 0;
    await scheduler.runPeriodicSync("bot");
    assert.equal(logs.length, 1, "the same signature must not be logged again");

    fail = false;
    scheduler.failureState.get("bot").nextAllowedAt = 0;
    await scheduler.runPeriodicSync("bot");
    const state = scheduler.failureState.get("bot");
    assert.equal(state.consecutive, 0);
    assert.equal(state.nextAllowedAt, 0);
    assert.equal(state.lastSignature, null);
  } finally {
    console.error = originalError;
  }
});
