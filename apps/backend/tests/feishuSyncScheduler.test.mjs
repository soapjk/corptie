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
