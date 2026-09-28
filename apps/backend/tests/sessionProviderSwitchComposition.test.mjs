import assert from "node:assert/strict";
import test from "node:test";
import { createSessionProviderSwitchComposition } from "../src/agent-provider/bootstrap/sessionProviderSwitchComposition.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const session = { id: "session:1", sessionKind: "worker", external: { cwd: "/workspace" } };
  const options = {
    store: {
      getSession: () => session,
      getSessionToolCatalogMaterialization: () => null
    },
    agentProviderRegistry: { invoke: async (...args) => { calls.push(["invoke", ...args]); return session; } },
    sessionBindingRepository: { resolve: () => ({ sessionId: session.id }) },
    collaborationCore: { getAgentForSession: () => ({ agentId: "agent:1" }) },
    ensureCollaborationAgentForSession: () => { throw new Error("unexpected fallback"); },
    toolHostService: {
      prepareSession: async (...args) => {
        calls.push(["tools", ...args]);
        return { providerAttachment: { dynamicTools: [] } };
      }
    },
    sessionApplicationService: {
      ensureActiveBindingToolsReady: async (...args) => { calls.push(["finalize", ...args]); return true; }
    },
    codexRuntime: {},
    prospectiveToolHostBinding: (input) => input.binding,
    toolHostMaterializationCoordinator: {
      prepareAppliedReplacement: async (input) => { calls.push(["applied", input]); return input; },
      prepareDesiredReplacement: async (input) => { calls.push(["desired", input]); return input; }
    },
    emitEvent: (...args) => calls.push(["event", ...args]),
    ...overrides
  };
  return { coordinator: createSessionProviderSwitchComposition(options), calls, session, options };
}

test("Worker switch context defaults to artifacts and summarizes existing instruction sources", async () => {
  const f = fixture();
  const context = await f.coordinator.resolveTargetContext({
    reference: { sessionId: f.session.id },
    logical: { logicalSessionId: "logical:1", activeBinding: {
      instructionSources: ["one", { title: "two" }, { summary: "three" }, { path: "/four" }]
    } },
    providerId: "target"
  });
  assert.deepEqual(context.desiredToolDomains, ["artifacts"]);
  assert.equal(context.instructionSummary, "one\ntwo\nthree\n/four");
  assert.equal(f.calls[0][1], "target");
  assert.equal(f.calls[0][2].sessionId, "session:1");
  assert.equal(context.agentId, "agent:1");
});

test("Tool replacement selects applied proof only when requested by the switch contract", async () => {
  const f = fixture();
  const input = {
    sessionId: "session:1", logicalSessionId: "logical:1",
    binding: { bindingId: "new" }, dynamicToolConfirmation: { providerRevision: "proof" }
  };
  await f.coordinator.prepareToolMaterialization(input);
  await f.coordinator.prepareToolMaterialization({ ...input, requiresApplied: true });
  assert.equal(f.calls[0][0], "desired");
  assert.equal(f.calls[1][0], "applied");
  assert.equal(f.calls[1][1].providerConfirmation, input.dynamicToolConfirmation);
});

test("non-Codex recovery resumes through the shared registry with the target route identity", async () => {
  const f = fixture();
  const result = await f.coordinator.resumeTargetSession({
    providerId: "target", providerThreadId: "thread:new", providerSessionId: "native:new",
    logicalSessionId: "logical:1", sourceLogical: { legacySessionId: "session:1" },
    transition: { sourceRoutingVersion: 4 }
  });
  const [, providerId, capability, reference, context] = f.calls[0];
  assert.equal(providerId, "target");
  assert.equal(capability, AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME);
  assert.equal(reference.providerSessionId, "native:new");
  assert.equal(reference.routingVersion, 5);
  assert.equal(context.purpose, "provider-switch-recovery");
  assert.equal(result.sessionProjection, f.session);
});

test("committed switch finalization passes exact binding and routing guards", async () => {
  const f = fixture();
  await f.coordinator.finalizeCommittedTarget({
    logicalSessionId: "logical:1", providerBindingId: "binding:new",
    providerSessionId: "native:new", routingVersion: 5,
    purpose: "switch-commit", desiredToolDomains: ["artifacts"]
  });
  assert.deepEqual(f.calls[0], ["finalize", "logical:1", {
    purpose: "switch-commit", desiredToolDomains: ["artifacts"],
    expectedLogicalSessionId: "logical:1", expectedProviderBindingId: "binding:new",
    expectedProviderSessionId: "native:new", expectedRoutingVersion: 5, activeTurn: false
  }]);
});
