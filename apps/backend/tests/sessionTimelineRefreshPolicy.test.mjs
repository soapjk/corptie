import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionTimelineRefreshScheduler,
  sessionEventMatchesTimeline,
  timelineRefreshInterval,
  timelineRefreshIntervals,
  timelineSessionIsActive
} from "../src/utils/sessionTimelineRefreshPolicy.mjs";

test("active sessions retain bounded tail sampling while idle sessions use consistency checks", () => {
  assert.equal(timelineSessionIsActive({ status: "running" }), true);
  assert.equal(timelineSessionIsActive({ status: "blocked" }), true);
  assert.equal(timelineSessionIsActive({ status: "complete", capabilities: { canInterrupt: true } }), true);
  assert.equal(timelineSessionIsActive({ status: "complete", activityStatus: null }), false);
  assert.equal(timelineRefreshInterval({ status: "running" }), timelineRefreshIntervals.activeMilliseconds);
  assert.equal(timelineRefreshInterval({ status: "complete" }), timelineRefreshIntervals.consistencyMilliseconds);
});

test("scheduler debounces matching events, adapts polling, and releases every timer", () => {
  const clock = fakeClock();
  const refreshes = [];
  const scheduler = new SessionTimelineRefreshScheduler({
    sessionId: "codex:one",
    supportsDelta: true,
    onRefresh: (options) => { refreshes.push(options); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });

  scheduler.schedule({ status: "running" });
  assert.deepEqual(clock.delays().sort((a, b) => a - b), [750, 30_000]);
  assert.equal(scheduler.wake({ sessionId: "codex:two" }), false);
  assert.equal(scheduler.wake({ sessionId: "codex:one" }), true);
  assert.equal(scheduler.wake({ sessionId: "codex:one" }), true);
  assert.deepEqual(clock.delays().sort((a, b) => a - b), [50, 750, 30_000]);
  clock.fireDelay(50);
  assert.deepEqual(refreshes, [{ fullConsistency: true }]);

  scheduler.schedule({ status: "complete" });
  assert.deepEqual(clock.delays(), [30_000]);
  scheduler.close();
  assert.deepEqual(clock.delays(), []);
  assert.equal(scheduler.wake({ sessionId: "codex:one" }), false);
});

test("legacy scheduler retains the compatibility polling cadence", () => {
  const clock = fakeClock();
  const scheduler = new SessionTimelineRefreshScheduler({
    sessionId: "codex:one",
    supportsDelta: false,
    onRefresh: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  scheduler.schedule({ status: "complete" });
  assert.deepEqual(clock.delays(), [400]);
  assert.equal(scheduler.wake({ sessionId: "codex:one" }), false);
});

function fakeClock() {
  let sequence = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    delays() {
      return [...timers.values()].map((timer) => timer.delay);
    },
    fireDelay(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `No timer at ${delay}ms`);
      timers.delete(entry[0]);
      entry[1].callback();
    }
  };
}

test("only events for the selected logical route wake its timeline", () => {
  assert.equal(sessionEventMatchesTimeline({ sessionId: "codex:one" }, "codex:one"), true);
  assert.equal(sessionEventMatchesTimeline({ sessionId: "codex:two" }, "codex:one"), false);
  assert.equal(sessionEventMatchesTimeline({}, "codex:one"), false);
});
