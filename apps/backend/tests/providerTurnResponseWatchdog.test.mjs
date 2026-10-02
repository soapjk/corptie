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
    get size() { return timers.size; },
    hasDelay(delay) { return [...timers.values()].some((timer) => timer.handle.delay === delay); }
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
  assert.equal(timers.size, 3);
  timers.run(20);
  await Promise.resolve();
  assert.deepEqual(delayed, [{ ...turn, startedAt: null }]);
  timers.run(120);
  await Promise.resolve();
  assert.deepEqual(timedOut, [{ ...turn, startedAt: null, timeoutKind: "inactivity" }]);
  assert.equal(timers.size, 0);
});

test("Provider activity resets inactivity timeout but keeps the absolute deadline", async () => {
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
  assert.equal(timers.size, 2);
  assert.equal(watchdog.watch(turn), false, "activity must not create a second watch entry");
  timers.run(120);
  await Promise.resolve();
  assert.equal(timedOut, true);
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

test("the watchdog delay notice does not count as Provider activity", async () => {
  const timers = scheduler();
  let timedOut = false;
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onTimeout: () => { timedOut = true; }
  });
  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "provider.error", payload: {
      willRetry: true,
      error: { code: "PROVIDER_RESPONSE_DELAYED" }
    } },
    binding: turn
  });
  timers.run(120);
  await Promise.resolve();
  assert.equal(timedOut, true);
});

test("a Provider retry delay extends only the rolling inactivity timer", () => {
  const timers = scheduler();
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    absoluteTimeoutAfterMs: 10_000,
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "provider.error", payload: {
      willRetry: true,
      retryAfterMs: 500
    } },
    binding: turn
  });
  assert.equal(timers.hasDelay(10_000), true, "absolute deadline remains armed");
  assert.equal(timers.hasDelay(5_500), true, "retry backoff extends the inactivity window with grace");
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

test("Provider activity cannot extend a Turn beyond the absolute deadline", async () => {
  const timers = scheduler();
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    absoluteTimeoutAfterMs: 500,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onTimeout: (entry) => timedOut.push(entry)
  });
  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "provider.activity", occurredAt: "2026-10-02T00:00:00.000Z" },
    binding: turn
  });
  timers.run(500);
  await Promise.resolve();
  assert.equal(timedOut[0].timeoutKind, "absolute");
  assert.equal(timedOut[0].lastActivityAt, "2026-10-02T00:00:00.000Z");
});
