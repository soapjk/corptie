import assert from "node:assert/strict";
import test from "node:test";
import { ProviderSessionLifecycle } from "../src/application/providerSessionLifecycle.mjs";

function fixture(providerId = "codex-app-server") {
  const calls = [];
  const session = { id: "session:test", external: { cwd: "/tmp/lifecycle-test" } };
  const adapter = {
    async normalizePermissions(value) { assert.equal(this, adapter); calls.push("permissions"); return value; },
    async threadOptions() { assert.equal(this, adapter); calls.push("options"); return {}; },
    async ensureResumed(id) { assert.equal(this, adapter); calls.push(id); return { alreadyLoaded: true }; },
    async stabilizeRecovery() { assert.equal(this, adapter); return { stabilized: true }; },
    async ensureLogicalRoute() { assert.equal(this, adapter); return null; }
  };
  const lifecycle = new ProviderSessionLifecycle({
    store: { getSession: () => session, getLogicalSessionByLegacySessionId: () => null },
    adapters: { [providerId]: adapter },
    collaborationThreadOptionsForSession: () => ({}), workspaceTransitionManager: {},
    workspaceRoutePreparationCache: {}, assertWorkspaceRouteUsable() {}, prepareExternalDiff() {},
    launchDiffTool() {}, writeTurnPatch() {}, safeTurnFileChanges() {}, turnDiffFor() {},
    workspaceTransitionBlocksWork: () => false, sessionHasActiveRun: () => false
  });
  const reference = { sessionId: session.id, providerId, providerSessionId: "thread:test" };
  return { lifecycle, reference, calls, adapter };
}

for (const providerId of ["codex-app-server", "claude-sdk", "test-provider"]) {
  test(`execution preparation retains the whole adapter and receiver: ${providerId}`, async () => {
    const { lifecycle, reference, calls } = fixture(providerId);
    const result = await lifecycle.prepareExecution(reference);
    assert.equal(result.prepared, true);
    assert.equal(result.threadAlreadyLoaded, true);
    assert.deepEqual(calls, ["permissions", "options", "thread:test"]);
  });
}

test("recovery stabilization resolves an adapter object", async () => {
  const { lifecycle, reference } = fixture();
  assert.deepEqual(await lifecycle.stabilizeRecoverySession(reference, {
    toolHost: { providerAttachment: {} }
  }), { stabilized: true });
});

test("restart reaches route-unavailable handling after adapter route lookup", async () => {
  const { lifecycle, reference } = fixture();
  await assert.rejects(lifecycle.restartSession(reference), { code: "SESSION_ROUTE_UNAVAILABLE" });
});

test("missing lifecycle operations remain explicit capability errors", async () => {
  const { lifecycle, reference, adapter } = fixture();
  delete adapter.ensureResumed;
  await assert.rejects(lifecycle.prepareExecution(reference), { code: "CAPABILITY_NOT_IMPLEMENTED" });
});
