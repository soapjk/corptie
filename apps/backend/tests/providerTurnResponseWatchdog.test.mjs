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
  assert.equal(timers.size, 2);
  timers.run(20);
  await Promise.resolve();
  assert.deepEqual(delayed, [{ ...turn, startedAt: null }]);
  timers.run(120);
  await Promise.resolve();
  assert.deepEqual(timedOut, [{ ...turn, startedAt: null, timeoutKind: "first_activity" }]);
  assert.equal(timers.size, 0);
});

test("substantive Provider activity arms a rolling timeout when heartbeats are reliable", async () => {
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
  assert.equal(timers.size, 1);
  assert.equal(watchdog.watch(turn), false, "activity must not create a second watch entry");
  timers.run(120);
  await Promise.resolve();
  assert.equal(timedOut, true);
});

test("a retry event suppresses the generic delay warning and keeps a bounded failure timeout", async () => {
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

test("an active Turn is not failed only because it exceeds the former absolute deadline", async () => {
  const timers = scheduler();
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    resolveTurnLiveness: () => ({ heartbeat: "best_effort" }),
    schedule: timers.schedule,
    cancel: timers.cancel,
    onTimeout: (entry) => timedOut.push(entry)
  });
  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "tool.completed", occurredAt: "2026-10-02T00:00:00.000Z" },
    binding: turn
  });
  timers.run(30 * 60_000);
  await Promise.resolve();
  assert.deepEqual(timedOut, []);
  assert.equal(timers.size, 1, "only the non-terminal stream-idle warning remains armed");
});

test("Provider without reliable heartbeats warns on stream silence but is not failed early", async () => {
  const timers = scheduler();
  const delayed = [];
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
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

  timers.run(30 * 60_000);
  await Promise.resolve();
  assert.deepEqual(timedOut, [], "elapsed wall-clock time alone cannot fail the Turn");
});

test("Provider heartbeat is not accepted as the first substantive response", async () => {
  const timers = scheduler();
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    resolveTurnLiveness: () => ({ heartbeat: "reliable" }),
    schedule: timers.schedule,
    cancel: timers.cancel,
    onTimeout: (entry) => timedOut.push(entry)
  });
  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "provider.activity", occurredAt: "2026-10-02T00:00:01.000Z" },
    binding: turn
  });
  timers.run(120);
  await Promise.resolve();
  assert.equal(timedOut[0].timeoutKind, "first_activity");
  assert.equal(timedOut[0].lastProviderSignalAt, "2026-10-02T00:00:01.000Z");
});

test("Provider heartbeat cannot clear a retry failure deadline", async () => {
  const timers = scheduler();
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    resolveTurnLiveness: () => ({ heartbeat: "reliable" }),
    schedule: timers.schedule,
    cancel: timers.cancel,
    onTimeout: (entry) => timedOut.push(entry)
  });
  watchdog.watch(turn);
  watchdog.observe({ event: { ...turn, type: "tool.started" }, binding: turn });
  watchdog.observe({
    event: { ...turn, type: "provider.error", occurredAt: "2026-10-02T00:00:01.000Z", payload: {
      willRetry: true,
      error: { code: "NETWORK_UNAVAILABLE", message: "offline" }
    } },
    binding: turn
  });
  watchdog.observe({ event: { ...turn, type: "provider.activity" }, binding: turn });
  assert.equal(timers.countDelay(120), 1);
  timers.run(120);
  await Promise.resolve();
  assert.equal(timedOut[0].timeoutKind, "provider_retry");
});

test("substantive activity clears a Provider retry failure deadline", async () => {
  const timers = scheduler();
  const delayed = [];
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
    resolveTurnLiveness: () => ({ heartbeat: "best_effort" }),
    schedule: timers.schedule,
    cancel: timers.cancel,
    onDelayed: (entry) => delayed.push(entry),
    onTimeout: (entry) => timedOut.push(entry)
  });
  watchdog.watch(turn);
  watchdog.observe({
    event: { ...turn, type: "provider.error", occurredAt: "2026-10-02T00:00:01.000Z", payload: {
      willRetry: true,
      error: { code: "NETWORK_UNAVAILABLE", message: "offline" }
    } },
    binding: turn
  });
  watchdog.observe({
    event: { ...turn, type: "tool.completed", occurredAt: "2026-10-02T00:00:02.000Z" },
    binding: turn
  });
  assert.equal(timers.countDelay(120), 1, "only the non-terminal stream-idle warning remains");
  timers.run(120);
  await Promise.resolve();
  assert.deepEqual(timedOut, []);
  assert.equal(delayed[0].warningKind, "stream_idle");
  assert.equal(delayed[0].lastFailureAt, undefined);
  assert.equal(delayed[0].lastProviderError, undefined);
});

test("a long-running tool on a Provider without reliable heartbeats remains active", async () => {
  const timers = scheduler();
  const timedOut = [];
  const watchdog = new ProviderTurnResponseWatchdog({
    warningAfterMs: 20,
    timeoutAfterMs: 120,
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
