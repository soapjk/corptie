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
    hasDelay(delay) { return [...timers.values()].some((timer) => timer.handle.delay === delay); },
    countDelay(delay) { return [...timers.values()].filter((timer) => timer.handle.delay === delay).length; }
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
    resolveTurnLiveness: () => ({ heartbeat: "reliable" }),
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

test("a retry event suppresses the generic delay warning and keeps a hard timeout without reliable heartbeats", async () => {
  const timers = scheduler();
  let delayed = false;
  let timedOut = false;
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    resolveTurnLiveness: () => ({ heartbeat: "best_effort" }),
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

test("Provider retry backoff cannot extend the first failure deadline", () => {
  const timers = scheduler();
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    absoluteTimeoutAfterMs: 10_000,
    resolveTurnLiveness: () => ({ heartbeat: "best_effort" }),
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
  assert.equal(timers.hasDelay(120), true, "the first retry keeps a bounded failure deadline");
  watchdog.observe({
    event: { ...turn, type: "provider.error", payload: {
      willRetry: true,
      retryAfterMs: 5_000
    } },
    binding: turn
  });
  assert.equal(timers.countDelay(120), 1, "repeated retries do not postpone the first deadline");
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

test("Provider without reliable heartbeats warns on stream silence but is not failed early", async () => {
  const timers = scheduler();
  const delayed = [];
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    absoluteTimeoutAfterMs: 500,
    resolveTurnLiveness: () => ({ heartbeat: "best_effort" }),
    schedule: timers.schedule,
    cancel: timers.cancel,
    onDelayed: (entry) => delayed.push(entry),
    onTimeout: (entry) => timedOut.push(entry)
  });
  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "assistant.message.started", occurredAt: "2026-10-02T00:00:00.000Z" },
    binding: turn
  });

  assert.equal(timers.hasDelay(120), true, "stream silence gets a one-shot warning timer");
  timers.run(120);
  await Promise.resolve();
  assert.deepEqual(delayed, [{
    ...turn,
    startedAt: null,
    lastActivityAt: "2026-10-02T00:00:00.000Z",
    warningKind: "stream_idle"
  }]);
  assert.deepEqual(timedOut, [], "stream silence is not proof of failure without reliable heartbeats");

  timers.run(500);
  await Promise.resolve();
  assert.equal(timedOut[0].timeoutKind, "absolute");
});

test("a long-running tool on a Provider without reliable heartbeats remains active", async () => {
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
  watchdog.observe({ event: { ...turn, type: "tool.started" }, binding: turn });
  timers.run(120);
  await Promise.resolve();
  assert.deepEqual(timedOut, []);
  watchdog.observe({ event: { ...turn, type: "tool.completed" }, binding: turn });
  watchdog.observe({ event: { ...turn, type: "turn.completed" }, binding: turn });
  assert.equal(timers.size, 0);
});
