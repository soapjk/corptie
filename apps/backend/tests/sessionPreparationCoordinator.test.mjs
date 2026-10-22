import assert from "node:assert/strict";
import test from "node:test";
import { SessionBindingReadinessProbe } from "../src/application/sessionBindingReadinessProbe.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
test("server composition before Store opens does not permanently poison preparation storage", async () => {
  let storeOpen = false;
  let reads = 0;
  let snapshot = null;
  const persistence = {
    read: () => {
      reads++;
      assert.ok(storeOpen, "must not read an unopened Store");
      return snapshot;
    },
    write: value => { assert.ok(storeOpen); snapshot = value; }
  };
  const f = fixture({ deferRestore: true }, persistence);
  assert.equal(reads, 0);
  storeOpen = true;
  await f.preparations.resumeAtStartup();
  assert.equal(reads, 1);
  const first = await f.preparations.start("one");
  await tick();
  f.gates.get("one").resolve({ prepared: true });
  await tick();
  assert.equal((await f.preparations.current("one")).state, "ready");
  assert.equal(snapshot.records[0].id, first.id);
  assert.equal(reads, 1);
});

function fixture(limits = {}, persistence = null) {
  const gates = new Map();
  let binding = "binding";
  let calls = 0;
  const probe = new SessionBindingReadinessProbe({
    preparationLimits: limits,
    preparationPersistence: persistence,
    resolveReference: async sessionId => ({ sessionId, logicalSessionId: sessionId,
      bindingId: binding, providerId: "test-provider" }),
    probe: async (sessionId, context) => {
      if (context.reconcileOnly) return { ready: false, reasonCode: "PROVIDER_RECONCILIATION_UNSUPPORTED" };
      calls++;
      return new Promise((resolve, reject) => gates.set(sessionId, { resolve, reject }));
    }
  });
  return { probe, preparations: probe.preparations, gates, calls: () => calls,
    replaceBinding: value => { binding = value; } };
}

test("asynchronous preparations single-flight per binding and retain ready result", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.preparations.start("one"), f.preparations.start("one")]);
  assert.equal(first.id, second.id);
  await tick();
  assert.equal(f.calls(), 1);
  assert.equal((await f.preparations.current("one")).state, "verifying");
  f.gates.get("one").resolve({ prepared: true });
  await tick();
  assert.equal((await f.preparations.current("one")).state, "ready");
  assert.equal((await f.preparations.start("one")).id, first.id);
});

test("global concurrency and queue limits bound real underlying operations", async () => {
  const f = fixture({ concurrency: 1, queueLimit: 1 });
  await f.preparations.start("one");
  const queued = await f.preparations.start("two");
  assert.equal(queued.state, "queued");
  await assert.rejects(f.preparations.start("three"), { code: "SESSION_PREPARATION_BUSY" });
  await tick();
  assert.equal(f.calls(), 1);
  f.gates.get("one").resolve({});
  await tick();
  assert.equal(f.calls(), 2);
  f.gates.get("two").resolve({});
  await tick();
  assert.equal(f.preparations.active, 0);
});

test("cancel retires readiness but does not release a running slot or replay unknown work", async () => {
  const f = fixture({ concurrency: 1 });
  const first = await f.preparations.start("one");
  await tick();
  const cancelled = await f.preparations.cancel("one", first.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.remoteDisposition, "unknown");
  assert.equal(cancelled.retryable, false);
  await f.preparations.start("two");
  assert.equal((await f.preparations.start("one")).id, first.id);
  assert.equal(f.calls(), 1);
  f.gates.get("one").resolve({});
  await tick();
  assert.notEqual(f.probe.readiness("one", "binding"), null);
  assert.equal((await f.preparations.current("one")).state, "cancelled");
  assert.equal((await f.preparations.start("one")).id, first.id);
  f.gates.get("two").resolve({});
  await tick();
});

test("queued cancellation is not sent and stale cancellation cannot cancel its replacement", async () => {
  const f = fixture({ concurrency: 1 });
  await f.preparations.start("one");
  const queued = await f.preparations.start("two");
  const cancelled = await f.preparations.cancel("two", queued.id);
  assert.equal(cancelled.remoteDisposition, "not_sent");
  assert.equal(cancelled.retryable, true);
  const replacement = await f.preparations.start("two");
  assert.notEqual(replacement.id, queued.id);
  await assert.rejects(f.preparations.cancel("two", queued.id), { code: "SESSION_PREPARATION_CHANGED" });
  await tick();
  f.gates.get("one").resolve({}); await tick();
  f.gates.get("two").resolve({}); await tick();
});

test("deadline stops local waiting but keeps unknown result quarantined after late success", async () => {
  const f = fixture({ deadlineMs: 10 });
  const first = await f.preparations.start("one");
  await tick();
  await new Promise(resolve => setTimeout(resolve, 25));
  const failed = await f.preparations.current("one");
  assert.equal(failed.reasonCode, "SESSION_PREPARATION_DEADLINE");
  assert.equal(failed.remoteDisposition, "unknown");
  assert.equal(f.preparations.active, 1);
  f.gates.get("one").resolve({}); await tick();
  assert.notEqual(f.probe.readiness("one", "binding"), null);
  assert.equal((await f.preparations.start("one")).id, first.id);
});

test("RPC timeout remains unknown while explicit Provider invalidation permits a new generation", async () => {
  const f = fixture();
  const first = await f.preparations.start("one"); await tick();
  f.gates.get("one").reject(Object.assign(new Error("private"), { code: "PROVIDER_RPC_TIMEOUT" }));
  await tick();
  const failed = await f.preparations.current("one");
  assert.equal(failed.state, "failed");
  assert.equal(failed.remoteDisposition, "unknown");
  assert.ok(!JSON.stringify(failed).includes("private"));
  assert.equal((await f.preparations.start("one")).id, first.id);
  f.probe.invalidateBinding({ sessionId: "one", logicalSessionId: "one", bindingId: "binding" });
  assert.equal((await f.preparations.start("one")).id, first.id,
    "readiness invalidation alone must not prove a remote restart");
  f.probe.invalidateProvider("test-provider");
  assert.equal((await f.preparations.start("one")).id, first.id,
    "a Provider readiness transition must not imply a proven new process epoch");
  await tick();
  f.probe.invalidateProvider("test-provider", { runtimeChanged: true });
  const next = await f.preparations.start("one");
  assert.notEqual(next.id, first.id);
  await tick(); f.gates.get("one").resolve({}); await tick();
});

test("stopping confirmation after an RPC timeout cancels waiting without another native resume", async () => {
  const f = fixture();
  const first = await f.preparations.start("one");
  await tick();
  f.gates.get("one").reject(Object.assign(new Error("timeout"), { code: "PROVIDER_RPC_TIMEOUT" }));
  await tick();
  const cancelled = await f.preparations.cancel("one", first.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.remoteDisposition, "unknown");
  assert.equal((await f.preparations.current("one")).state, "cancelled");
  assert.equal(f.calls(), 1);
});

test("route change during a running preparation never makes its replacement ready", async () => {
  const f = fixture();
  await f.preparations.start("one"); await tick();
  f.replaceBinding("replacement");
  f.gates.get("one").resolve({}); await tick();
  assert.equal(await f.preparations.current("one"), null);
  assert.notEqual(f.probe.readiness("one", "replacement"), null);
});

test("record storage is bounded and cannot evict quarantined unknown results", async () => {
  const f = fixture({ recordLimit: 1 });
  await f.preparations.start("one"); await tick();
  f.gates.get("one").reject(Object.assign(new Error("timeout"), { code: "PROVIDER_RPC_TIMEOUT" }));
  await tick();
  await assert.rejects(f.preparations.start("two"), { code: "SESSION_PREPARATION_BUSY" });
  assert.equal(f.preparations.records.size, 1);
});

test("durable intent precedes RPC; restart quarantines verifying and never replays it", async () => {
  let snapshot;
  const persistence = { read: () => snapshot, write: value => { snapshot = structuredClone(value); } };
  const f = fixture({}, persistence);
  await f.preparations.start("one"); await tick();
  assert.equal(snapshot.records[0].state, "verifying");
  const restarted = fixture({}, persistence);
  const state = await restarted.preparations.current("one");
  assert.equal(state.state, "failed");
  assert.equal(state.reasonCode, "SESSION_PREPARATION_RESTARTED");
  assert.equal(state.remoteDisposition, "unknown");
  await restarted.preparations.start("one"); await tick();
  assert.equal(restarted.calls(), 0);
  f.gates.get("one").resolve({}); await tick();
});

test("restart does not trust previously ready state and queued not-sent work can retry", async () => {
  let snapshot;
  const persistence = { read: () => snapshot, write: value => { snapshot = structuredClone(value); } };
  const f = fixture({ concurrency: 1 }, persistence);
  await f.preparations.start("one");
  const queued = await f.preparations.start("two");
  const whileQueued = structuredClone(snapshot);
  await tick(); f.gates.get("one").resolve({}); await tick();
  const whileReady = structuredClone(snapshot);
  const restartReady = fixture({}, { read: () => whileReady, write: () => {} });
  assert.equal((await restartReady.preparations.current("one")).state, "failed");
  assert.equal(restartReady.probe.readiness("one", "binding"), undefined);
  const restartQueued = fixture({}, { read: () => whileQueued, write: () => {} });
  const state = await restartQueued.preparations.current("two");
  assert.equal(state.remoteDisposition, "not_sent");
  const retried = await restartQueued.preparations.start("two");
  assert.notEqual(retried.id, queued.id);
  await tick(); restartQueued.gates.get("two").resolve({});
  f.gates.get("two").resolve({}); await tick();
});

test("corrupt or unavailable persistence fails closed before any Provider call", async () => {
  for (const persistence of [
    { read: () => ({ version: 99, records: [] }), write: () => {} },
    { read: () => null, write: () => { throw new Error("disk unavailable"); } }
  ]) {
    const f = fixture({}, persistence);
    await assert.rejects(f.preparations.start("one"), { code: "SESSION_PREPARATION_STORAGE_UNAVAILABLE" });
    assert.equal(f.calls(), 0);
  }
});

test("unknown outcome reconciles only through read-only proof, never another preparation RPC", async () => {
  const f = fixture();
  let applied = false, reconciliations = 0;
  const originalProbe = f.probe.probe;
  f.probe.probe = (sessionId, context) => {
    if (!context.reconcileOnly) return originalProbe(sessionId, context);
    reconciliations++;
    return { ready: applied, reasonCode: "PROVIDER_RESUME_OUTCOME_UNKNOWN" };
  };
  const first = await f.preparations.start("one"); await tick();
  f.gates.get("one").reject(Object.assign(new Error("timeout"), { code: "PROVIDER_RPC_TIMEOUT" }));
  await tick();
  await f.preparations.start("one"); await tick();
  assert.equal((await f.preparations.current("one")).remoteDisposition, "unknown");
  assert.equal(f.calls(), 1);
  applied = true;
  f.preparations.records.values().next().value.reconcileAfter = 0;
  assert.equal((await f.preparations.start("one")).id, first.id); await tick();
  assert.equal((await f.preparations.current("one")).state, "ready");
  assert.equal(f.calls(), 1);
  assert.equal(reconciliations, 2);
});

test("startup recovery is single-flight, bounded-backoff, resumes not-sent only and honors cancellation", async () => {
  let snapshot;
  const f = fixture({ concurrency: 1 }, {
    read: () => null, write: value => { snapshot = structuredClone(value); }
  });
  await f.preparations.start("unknown");
  await f.preparations.start("unsent");
  const cancelled = await f.preparations.start("cancelled");
  await f.preparations.cancel("cancelled", cancelled.id);
  const saved = structuredClone(snapshot);
  await tick(); f.gates.get("unknown").resolve({}); await tick();
  f.gates.get("unsent").resolve({}); await tick();
  const restarted = fixture({}, { read: () => saved, write: () => {} });
  const delays = [];
  const recovery = restarted.preparations.resumeAtStartup({ sleep: async milliseconds => {
    delays.push(milliseconds); await tick();
  } });
  assert.equal(restarted.preparations.resumeAtStartup(), recovery);
  const summary = await recovery;
  await tick();
  assert.deepEqual(delays, [30000, 60000]);
  assert.equal(summary.candidates, 2);
  assert.equal(restarted.calls(), 1);
  assert.equal(restarted.gates.has("unknown"), false);
  assert.equal(restarted.gates.has("cancelled"), false);
  assert.equal((await restarted.preparations.current("cancelled")).state, "cancelled");
  restarted.probe.invalidateProvider("test-provider");
  assert.equal((await restarted.preparations.current("cancelled")).state, "cancelled");
  restarted.gates.get("unsent").resolve({}); await tick();
});

test("persisted unknown after restart automatically verifies when the adapter proves no pending resume", async () => {
  let snapshot;
  const f = fixture({}, { read: () => null, write: value => { snapshot = structuredClone(value); } });
  const first = await f.preparations.start("one"); await tick();
  const saved = structuredClone(snapshot);
  f.gates.get("one").resolve({}); await tick();
  const restarted = fixture({}, { read: () => saved, write: () => {} });
  const original = restarted.probe.probe;
  restarted.probe.probe = (id, context) => context.reconcileOnly
    ? { ready: false, canRetryVerification: true, reasonCode: "PROVIDER_RESUME_OUTCOME_UNKNOWN" }
    : original(id, context);
  await restarted.preparations.resumeAtStartup({ sleep: tick }); await tick();
  assert.equal(restarted.calls(), 1, "cold proof must trigger a real verification rather than permanent waiting");
  assert.equal((await restarted.preparations.current("one")).id, first.id);
  restarted.gates.get("one").resolve({}); await tick();
  assert.equal((await restarted.preparations.current("one")).state, "ready");
  assert.equal(restarted.probe.readiness("one", "binding"), null);
});

test("late rejection allows a fresh verification while unresolved resumes never repeat", async () => {
  const f = fixture();
  const first = await f.preparations.start("one"); await tick();
  f.gates.get("one").reject(Object.assign(new Error("timeout"), { code: "PROVIDER_RPC_TIMEOUT" }));
  await tick();
  let safe = false;
  const original = f.probe.probe;
  f.probe.probe = (id, context) => context.reconcileOnly
    ? { ready: false, canRetryVerification: safe, reasonCode: "PROVIDER_RESUME_OUTCOME_UNKNOWN" }
    : original(id, context);
  await f.preparations.start("one"); await tick();
  assert.equal(f.calls(), 1);
  assert.equal((await f.preparations.current("one")).remoteDisposition, "unknown");
  safe = true;
  f.preparations.records.values().next().value.reconcileAfter = 0;
  await Promise.all([f.preparations.start("one"), f.preparations.start("one")]); await tick();
  assert.equal(f.calls(), 2, "concurrent polling must issue only one new verification");
  f.gates.get("one").resolve({}); await tick();
  assert.equal((await f.preparations.current("one")).id, first.id);
  assert.equal((await f.preparations.current("one")).state, "ready");
});

for (const action of ["cancel", "replace"]) {
  test(`${action} during reconciliation cannot launch a newly permitted verification`, async () => {
    const f = fixture();
    const first = await f.preparations.start("one"); await tick();
    f.gates.get("one").reject(Object.assign(new Error("timeout"), { code: "PROVIDER_RPC_TIMEOUT" }));
    await tick();
    let release;
    f.probe.probe = () => new Promise(resolve => { release = resolve; });
    await f.preparations.start("one"); await tick();
    if (action === "cancel") await f.preparations.cancel("one", first.id);
    else f.replaceBinding("replacement");
    release({ ready: false, canRetryVerification: true }); await tick();
    assert.equal(f.calls(), 1);
    assert.notEqual(f.probe.readiness("one", "replacement"), null);
  });
}
