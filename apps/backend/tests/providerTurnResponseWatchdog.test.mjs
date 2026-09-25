import assert from "node:assert/strict";
import test from "node:test";
import { ProviderTurnResponseWatchdog } from "../src/application/providerTurnResponseWatchdog.mjs";

function scheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    schedule(callback, delay) {
      const handle = { id: nextId++, delay, unref() {} };
      timers.set(handle.id, { handle, callback });
      return handle;
    },
    cancel(handle) { timers.delete(handle?.id); },
    run(delay) {
      const matches = [...timers.values()].filter((timer) => timer.handle.delay === delay);
      for (const timer of matches) {
        timers.delete(timer.handle.id);
        timer.callback();
      }
    },
    get size() { return timers.size; }
  };
}

const turn = {
  sessionId: "session:one",
  logicalSessionId: "logical:one",
  providerId: "provider:test",
  providerSessionId: "provider-session:one",
  bindingId: "binding:one",
  routingVersion: 1,
  turnId: "turn:one"
};

test("a silent Provider Turn warns and then times out", async () => {
  const timers = scheduler();
  const delayed = [];
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onDelayed: (entry) => delayed.push(entry),
    onTimeout: (entry) => timedOut.push(entry)
  });

  assert.equal(watchdog.watch(turn), true);
  assert.equal(timers.size, 2);
  timers.run(20);
  await Promise.resolve();
  assert.deepEqual(delayed, [{ ...turn, startedAt: null }]);
  timers.run(120);
  await Promise.resolve();
  assert.deepEqual(timedOut, [{ ...turn, startedAt: null }]);
  assert.equal(timers.size, 0);
});

test("first substantive Provider activity permanently disarms the watchdog", async () => {
  const timers = scheduler();
  let timedOut = false;
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onTimeout: () => { timedOut = true; }
  });

  watchdog.observe({ event: { ...turn, type: "turn.started" }, binding: turn });
  assert.equal(watchdog.observe({
    event: { ...turn, type: "tool.started" },
    binding: turn
  }), true);
  assert.equal(timers.size, 0);
  assert.equal(watchdog.watch(turn), false, "late command acknowledgement must not re-arm a responsive Turn");
  timers.run(120);
  await Promise.resolve();
  assert.equal(timedOut, false);
});

test("a retry event suppresses the generic delay warning but keeps the hard timeout", async () => {
  const timers = scheduler();
  let delayed = false;
  let timedOut = false;
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onDelayed: () => { delayed = true; },
    onTimeout: () => { timedOut = true; }
  });

  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "provider.error", payload: { willRetry: true } },
    binding: turn
  });
  timers.run(20);
  await Promise.resolve();
  assert.equal(delayed, false);
  timers.run(120);
  await Promise.resolve();
  assert.equal(timedOut, true);
});

test("terminal events disarm the watchdog", () => {
  const timers = scheduler();
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  watchdog.watch(turn);
  watchdog.observe({ event: { ...turn, type: "turn.failed" }, binding: turn });
  assert.equal(timers.size, 0);
});
