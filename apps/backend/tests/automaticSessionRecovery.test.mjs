import test from "node:test";
import assert from "node:assert/strict";
import { createAutomaticSessionRecovery, isMissingProviderSession } from "../src/application/automaticSessionRecovery.mjs";
import { SessionBindingReadinessProbe } from "../src/application/sessionBindingReadinessProbe.mjs";

const missing = () => Object.assign(new Error("missing thread"), { code: "PROVIDER_SESSION_UNAVAILABLE", safeToRetry: true });
const reference = () => ({ sessionId: "session:1", logicalSessionId: "logical:1", bindingId: "binding:old", providerId: "test", providerSessionId: "old" });

test("only authoritative missing-thread errors permit reconstruction", () => {
  assert.equal(isMissingProviderSession(missing()), true);
  for (const error of [{ code: "PROVIDER_RPC_TIMEOUT" }, { code: "PROVIDER_SESSION_UNAVAILABLE" },
    { code: "AUTH_FAILED", safeToRetry: true }]) assert.equal(isMissingProviderSession(error), false);
  assert.equal(isMissingProviderSession({ code: "PROVIDER_SESSION_UNAVAILABLE", replacementReason: "provider-session-not-found" }), true);
});

test("opening a missing binding coalesces recovery and verifies the replacement once", async () => {
  let current = reference(), recoveries = 0, probes = 0;
  const notices = [];
  const recoverMissing = createAutomaticSessionRecovery({ resolveReference: async () => current,
    recover: async input => {
      recoveries += 1;
      assert.equal(input.idempotencyKey, "missing-thread-recovery:binding:old");
      current = { ...current, bindingId: "binding:new", providerSessionId: "new" };
      return { state: "committed" };
    } });
  const probe = new SessionBindingReadinessProbe({ resolveReference: async () => ({ ...current }), recoverMissing,
    probe: async () => { probes += 1; if (current.bindingId === "binding:old") throw missing(); return { ready: true }; },
    onChanged: () => notices.push(probe.readiness(current.logicalSessionId, "binding:old")?.reasonCode) });
  const results = await Promise.all([probe.verify("session:1"), probe.verify("session:1")]);
  assert.ok(results.every(result => result.ready && result.recoveredBindingId === "binding:new"));
  assert.equal(recoveries, 1); assert.equal(probes, 2);
  assert.ok(notices.includes("BINDING_RECOVERING"));
});

test("failed recovery backs off without generating another identity; route changes supersede old errors", async () => {
  let now = 0, calls = 0, current = reference();
  const recover = createAutomaticSessionRecovery({ clock: () => now, resolveReference: async () => current,
    recover: async input => { calls += 1; assert.equal(input.triggerDeliveryId, "delivery:1"); throw new Error("offline"); } });
  const input = { reference: current, error: missing(), triggerDeliveryId: "delivery:1" };
  await assert.rejects(recover(input), /offline/);
  await assert.rejects(recover(input), /offline/); assert.equal(calls, 1);
  now = 30001; await assert.rejects(recover(input), /offline/); assert.equal(calls, 2);
  current = { ...current, bindingId: "new" };
  assert.equal(await recover(input), current); assert.equal(calls, 2);
});

test("a missing replacement cannot recurse into endless automatic reconstruction", async () => {
  let current = reference(), calls = 0;
  const probe = new SessionBindingReadinessProbe({ resolveReference: async () => current,
    probe: async () => { throw missing(); },
    recoverMissing: async () => { calls += 1; current = { ...current, bindingId: "new" }; } });
  const result = await probe.verify("session:1");
  assert.equal(result.ready, false); assert.equal(calls, 1);
});
