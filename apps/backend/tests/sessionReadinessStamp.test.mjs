import assert from "node:assert/strict";
import test from "node:test";
import { sessionReadinessStamp } from "../src/application/sessionReadinessStamp.mjs";
import { SessionBindingReadinessProbe } from "../src/application/sessionBindingReadinessProbe.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { createOpenClackyProvider } from "../src/agent-provider/providers/openClackyProvider.mjs";

test("readiness stamps cover route/options/permissions/catalog but exclude unrelated timeline and credentials", () => {
  const reference = { sessionId: "one", bindingId: "binding", providerId: "provider", routingVersion: 1,
    readinessContractRevision: "tools:1", metadata: { session: { external: { currentModel: "model" } } } };
  const stamp = sessionReadinessStamp(reference);
  assert.equal(sessionReadinessStamp({ ...reference, metadata: { session: { ...reference.metadata.session,
    title: "changed title", credential: "secret" } } }), stamp);
  for (const patch of [{ routingVersion: 2 }, { readinessContractRevision: "tools:2" },
    { metadata: { session: { external: { currentModel: "changed" } } } },
    { metadata: { session: { external: { permissions: { access: "changed" } } } } }]) {
    assert.notEqual(sessionReadinessStamp({ ...reference, ...patch }), stamp);
  }
});

test("same-binding model/catalog changes during verification cannot publish ready", async () => {
  let reference = { sessionId: "one", logicalSessionId: "one", bindingId: "binding", providerId: "provider",
    readinessContractRevision: "tools:1" };
  let release;
  const probe = new SessionBindingReadinessProbe({ resolveReference: async () => reference,
    probe: () => new Promise(resolve => { release = resolve; }) });
  const verification = probe.verify("one"); await new Promise(resolve => setImmediate(resolve));
  reference = { ...reference, readinessContractRevision: "tools:2" };
  release({ ready: true });
  assert.equal((await verification).ready, false);
  assert.notEqual(probe.readiness("one", "binding"), null);
});

test("unsupported Providers reject reconciliation without launching queries or refreshing remote state", async () => {
  const manager = new Proxy({}, { get: () => () => { throw new Error("must not call manager"); } });
  for (const provider of [createClaudeAgentSdkProvider(manager), createOpenClackyProvider(manager)]) {
    const result = await provider.probeBinding({ providerSessionId: "one" }, { reconcileOnly: true });
    assert.equal(result.ready, false);
    assert.equal(result.reasonCode, "PROVIDER_RECONCILIATION_UNSUPPORTED");
  }
});

test("cached readiness never crosses runtime epochs and accepts only proof from the current epoch", async () => {
  let epoch = "old", calls = 0;
  const probe = new SessionBindingReadinessProbe({
    resolveReference: async () => ({ sessionId: "one", logicalSessionId: "one", bindingId: "binding",
      providerId: "provider", readinessRuntimeEpoch: epoch }),
    probe: async () => { calls++; return { ready: true, runtimeEpoch: epoch }; }
  });
  assert.equal((await probe.verify("one")).ready, true);
  assert.equal((await probe.verify("one", { reuseReady: true })).cached, true);
  epoch = "new";
  assert.equal((await probe.verify("one", { reuseReady: true })).cached, undefined);
  assert.equal(calls, 2);
  probe.probe = async () => ({ ready: true, runtimeEpoch: "old" });
  assert.equal((await probe.verify("one")).ready, false);
});

test("Claude query replacement and OpenClacky socket replacement invalidate pure local epochs", () => {
  const reference = { providerSessionId: "one" };
  const session = { query: {}, queryClosed: false };
  const claude = createClaudeAgentSdkProvider({ get: () => session });
  const first = claude.readinessEpoch(reference);
  assert.equal(claude.readinessEpoch(reference), first);
  session.queryClosed = true;
  assert.notEqual(claude.readinessEpoch(reference), first);
  session.query = {}; session.queryClosed = false;
  assert.notEqual(claude.readinessEpoch(reference), first);
  const sockets = new Map([["one", { readyState: 1 }]]);
  const clacky = createOpenClackyProvider({ sockets });
  const connected = clacky.readinessEpoch(reference);
  sockets.get("one").readyState = 3;
  assert.notEqual(clacky.readinessEpoch(reference), connected);
  sockets.set("one", { readyState: 1 });
  assert.notEqual(clacky.readinessEpoch(reference), connected);
  assert.equal(claude.descriptor.metadata.bindingReadiness.reconciliation, "unsupported");
  assert.equal(clacky.descriptor.metadata.bindingReadiness.reconciliation, "unsupported");
});
