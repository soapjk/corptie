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
