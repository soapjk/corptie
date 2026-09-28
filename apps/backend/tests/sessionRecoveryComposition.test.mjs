import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRecoveryComposition } from "../src/agent-provider/bootstrap/sessionRecoveryComposition.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const composition = createSessionRecoveryComposition({
    store: {
      freezeSessionRecoveryAttempt() {}, claimSessionRecoveryBoundary() {},
      replaceSessionRecoveryReplacement() {}, commitSessionRecoveryBinding() {},
      getSession: () => ({ id: "session:1", sessionKind: "worker", agentId: "agent:1" })
    },
    agentProviderRegistry: {
      get: () => ({ descriptor: { capabilities: [] } }),
      invoke: async (...args) => { calls.push(args); return { id: "native:1" }; }
    },
    runBackgroundAgent: async () => { throw new Error("unexpected background operation"); },
    sessionApplicationService: {},
    toolHostService: { prepareSession: async () => ({ providerAttachment: { dynamicTools: [] } }) },
    codexRuntime: {},
    prospectiveToolHostBinding: (value) => value,
    toolHostMaterializationCoordinator: {},
    emitEvent: (...args) => calls.push(args),
    ...overrides
  });
  const attempt = {
    sessionId: "session:1", logicalSessionId: "logical:1",
    providerId: "test-provider", sourceRoutingVersion: 2,
    boundCwd: "/workspace", toolCatalog: {}, permissionSnapshot: {}, artifactReferences: []
  };
  const replacement = {
    bindingId: "binding:new", providerThreadId: "thread:new", providerSessionId: "native:new",
    sessionProjection: { id: "replacement", external: { cwd: "/workspace" } }
  };
  return { composition, port: composition.providerPort, calls, attempt, replacement };
}

test("non-Codex replacement resume leaves its native recovery contract intact", async () => {
  const f = fixture();
  assert.equal(await f.port.resumeReplacement({
    attempt: f.attempt, replacement: f.replacement
  }), f.replacement);
  assert.deepEqual(f.calls, []);
});

test("only proven unrecoverable empty Codex targets may be recreated", async () => {
  let failure = Object.assign(new Error("ambiguous failure"), { code: "TRANSPORT_FAILURE" });
  const f = fixture({
    codexRuntime: { inspectEmptyThreadForRouteCommit: async () => { throw failure; } }
  });
  f.attempt.providerId = "codex-app-server";
  f.replacement.toolConfirmation = { providerRevision: "proof" };
  const created = [];
  f.port.createReplacement = async (input) => { created.push(input); return { recreated: true }; };
  const input = { attempt: f.attempt, replacement: f.replacement, manifest: {}, manifestHash: "hash" };
  await assert.rejects(f.port.resumeReplacement(input), { code: "TRANSPORT_FAILURE" });
  assert.equal(created.length, 0);
  failure = Object.assign(new Error("empty target lost"), {
    code: "PROVIDER_EMPTY_THREAD_UNRECOVERABLE", safeToRecreate: true
  });
  assert.deepEqual(await f.port.resumeReplacement(input), { recreated: true });
  assert.equal(created.length, 1);
  assert.equal(created[0].attempt, f.attempt);
  assert.equal(created[0].manifestHash, "hash");
});

test("recovery stabilization requires a declared capability before issuing native work", async () => {
  const f = fixture();
  await assert.rejects(f.port.stabilizeReplacement({
    attempt: f.attempt, replacement: f.replacement
  }), { code: "CAPABILITY_UNSUPPORTED" });
  assert.deepEqual(f.calls, []);
});

test("validation and rollback invoke the shared Provider registry with replacement binding identity", async () => {
  const f = fixture();
  const result = await f.port.validateReplacement({ attempt: f.attempt, replacement: f.replacement });
  assert.equal(result.readable, true);
  assert.equal(result.logicalSessionId, "logical:1");
  assert.equal(f.calls[0][0], "test-provider");
  assert.equal(f.calls[0][1], AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME);
  assert.equal(f.calls[0][2].bindingId, "binding:new");
  assert.equal(f.calls[0][2].routingVersion, 3);
  assert.equal(f.calls[0][3].purpose, "session-recovery-validation");
  await f.port.cancelReplacement({ attempt: f.attempt, replacement: f.replacement });
  assert.equal(f.calls[1][1], AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE);
  assert.equal(f.calls[1][2].providerSessionId, "native:new");
  assert.equal(f.calls[1][3].purpose, "session-recovery-rollback");
});
