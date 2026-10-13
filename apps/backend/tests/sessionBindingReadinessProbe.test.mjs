import assert from "node:assert/strict";
import test from "node:test";
import { SessionBindingReadinessProbe } from "../src/application/sessionBindingReadinessProbe.mjs";

function fixture(options = {}) {
  let reference = {
    sessionId: "session:one",
    logicalSessionId: "logical:one",
    bindingId: "binding:one",
    providerId: "provider:one",
    providerSessionId: "provider-session:one"
  };
  const changed = [];
  let calls = 0;
  const coordinator = new SessionBindingReadinessProbe({
    resolveReference: async () => ({ ...reference }),
    probe: async () => {
      calls += 1;
      if (options.gate) await options.gate;
      if (options.error) throw options.error;
      return { prepared: true };
    },
    onChanged: (sessionId) => changed.push(sessionId)
  });
  return {
    coordinator, changed,
    calls: () => calls,
    replaceBinding: (bindingId) => { reference = { ...reference, bindingId }; }
  };
}

test("binding verification publishes verifying then ready and coalesces concurrent probes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ gate });
  const first = f.coordinator.verify("session:one");
  const second = f.coordinator.verify("session:one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.coordinator.readiness("logical:one", "binding:one").reasonCode,
    "BINDING_RUNTIME_VERIFYING"
  );
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.ready, true);
  assert.equal(right.ready, true);
  assert.equal(f.calls(), 1);
  assert.equal(f.coordinator.readiness("logical:one", "binding:one"), null);
  assert.deepEqual(f.changed, ["session:one", "session:one"]);
});

test("rechecking an already-ready binding does not publish a transient not-ready state", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture();
  await f.coordinator.verify("session:one");
  assert.equal(f.coordinator.readiness("logical:one", "binding:one"), null);

  f.coordinator.probe = async () => {
    await gate;
    return { prepared: true };
  };
  const verification = f.coordinator.verify("session:one");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    f.coordinator.readiness("logical:one", "binding:one"),
    null,
    "a per-dispatch safety probe must preserve the last verified-ready UI projection"
  );
  release();
  assert.equal((await verification).ready, true);
  assert.deepEqual(
    f.changed,
    ["session:one", "session:one"],
    "ready-to-ready rechecks must not invalidate the client projection"
  );
});

test("message dispatch reuses the exact ready binding without probing again", async () => {
  const f = fixture();
  const first = await f.coordinator.verify("session:one");
  assert.equal(first.ready, true);
  assert.equal(f.calls(), 1);

  f.coordinator.probe = async () => {
    throw new Error("a cached dispatch must not reach the Provider probe");
  };
  const cached = await f.coordinator.verify("session:one", { reuseReady: true });

  assert.equal(cached.ready, true);
  assert.equal(cached.cached, true);
  assert.equal(f.calls(), 1);
  assert.equal(f.coordinator.readiness("logical:one", "binding:one"), null);
});

test("failed dispatch invalidation makes the next message probe again", async () => {
  const f = fixture();
  await f.coordinator.verify("session:one");
  assert.equal(f.calls(), 1);

  assert.equal(f.coordinator.invalidateBinding({
    sessionId: "session:one",
    logicalSessionId: "logical:one",
    bindingId: "binding:one"
  }), true);
  assert.equal(f.coordinator.readiness("logical:one", "binding:one"), undefined);

  const verification = await f.coordinator.verify("session:one", { reuseReady: true });
  assert.equal(verification.ready, true);
  assert.equal(verification.cached, undefined);
  assert.equal(f.calls(), 2);
});

test("Provider failure becomes binding-scoped not-ready state", async () => {
  const f = fixture({
    error: Object.assign(new Error("thread missing"), { code: "PROVIDER_SESSION_UNAVAILABLE" })
  });
  const result = await f.coordinator.verify("session:one");
  assert.equal(result.ready, false);
  assert.equal(result.readiness.reasonCode, "PROVIDER_SESSION_UNAVAILABLE");
  assert.match(result.readiness.message, /no longer exists/i);
  assert.equal(
    f.coordinator.readiness("logical:one", "binding:one").state,
    "not_ready"
  );
  assert.equal(f.coordinator.readiness("logical:one", "binding:other"), undefined);
});

test("a route change during verification never marks the replacement binding ready", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ gate });
  const verification = f.coordinator.verify("session:one");
  await new Promise((resolve) => setImmediate(resolve));
  f.replaceBinding("binding:two");
  release();
  const result = await verification;
  assert.equal(result.ready, false);
  assert.equal(result.readiness.reasonCode, "SESSION_BINDING_CHANGED");
  assert.equal(
    f.coordinator.readiness("logical:one", "binding:two").reasonCode,
    "SESSION_BINDING_CHANGED"
  );
});

for (const invalidation of ["binding", "provider"]) {
  for (const lateFailure of [false, true]) {
    test(`${invalidation} invalidation prevents late ${lateFailure ? "failure" : "success"} overwriting fresh readiness`, async () => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const f = fixture({ gate, error: lateFailure ? new Error("old failure") : null });
      const old = f.coordinator.verify("session:one");
      await new Promise(resolve => setImmediate(resolve));
      if (invalidation === "provider") f.coordinator.invalidateProvider("provider:one");
      else f.coordinator.invalidateBinding({ logicalSessionId: "logical:one", bindingId: "binding:one" });
      f.coordinator.probe = async () => ({ fresh: true });
      assert.equal((await f.coordinator.verify("session:one")).ready, true);
      release();
      const stale = await old;
      assert.equal(stale.ready, false);
      assert.equal(stale.readiness.reasonCode, "BINDING_VERIFICATION_SUPERSEDED");
      assert.equal(f.coordinator.readiness("logical:one", "binding:one"), null);
      assert.equal(f.coordinator.inFlight.size, 0);
    });
  }
}

test("a timeout is distinct from a missing Session and exposes no RPC details", async () => {
  const f = fixture({ error: Object.assign(new Error("private rpc metadata"), {
    code: "PROVIDER_RPC_TIMEOUT", remoteDisposition: "unknown", safeToRetry: false
  }) });
  const result = await f.coordinator.verify("session:one");
  assert.equal(result.ready, false);
  assert.equal(result.readiness.reasonCode, "PROVIDER_RPC_TIMEOUT");
  assert.match(result.readiness.message, /remote result is unknown/);
  assert.ok(!result.readiness.message.includes("private rpc metadata"));
});
