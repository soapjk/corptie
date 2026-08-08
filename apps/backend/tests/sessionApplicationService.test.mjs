import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES, AgentProviderCapabilityError } from "../src/agent-provider/contracts.mjs";
import { SessionApplicationService, SessionNotFoundError } from "../src/agent-provider/sessionApplicationService.mjs";

function fixture(capabilities = [
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH
]) {
  const calls = [];
  const provider = new CallbackAgentProvider({
    id: "fake.provider",
    displayName: "Fake Provider",
    transport: "fake",
    capabilities
  }, {
    listSessions: async () => [{ id: "logical-a", updatedAt: "2026-08-08T00:00:00.000Z" }],
    readSession: async (reference) => ({ id: reference.sessionId, source: "fake.provider" }),
    send: async (...args) => calls.push(["send", ...args]),
    interrupt: async (...args) => calls.push(["interrupt", ...args]),
    respondToApproval: async (...args) => calls.push(["respondToApproval", ...args]),
    switchModel: async (...args) => calls.push(["switchModel", ...args]),
    switchReasoning: async (...args) => calls.push(["switchReasoning", ...args])
  });
  const registry = new AgentProviderRegistry([provider]);
  const service = new SessionApplicationService({
    registry,
    resolveSessionReference: async (sessionId) => sessionId === "logical-a"
      ? {
          bindingId: "binding-a",
          providerId: "fake.provider",
          providerSessionId: "native-a",
          routingVersion: 3
        }
      : null
  });
  return { calls, registry, service };
}

test("Session application service resolves stable logical ids before Provider calls", async () => {
  const { calls, service } = fixture();
  await service.sendMessage("logical-a", "hello", { source: "desktop" });
  assert.deepEqual(calls, [[
    "send",
    {
      sessionId: "logical-a",
      requestedSessionId: "logical-a",
      logicalSessionId: null,
      bindingId: "binding-a",
      providerId: "fake.provider",
      providerSessionId: "native-a",
      routingVersion: 3,
      metadata: {}
    },
    "hello",
    { source: "desktop" }
  ]]);
});

test("Session application service exposes the same operations for every Provider", async () => {
  const { calls, service } = fixture();
  const detail = await service.readSession("logical-a");
  assert.equal(detail.id, "logical-a");
  assert.equal(detail.source, "fake.provider");
  assert.equal(detail.actions.send.available, true);
  assert.equal(detail.actions.interrupt.reason, "NO_ACTIVE_TURN");
  await service.interrupt("logical-a", { source: "desktop" });
  await service.respondToApproval("logical-a", { approved: true });
  await service.switchModel("logical-a", "fake-model");
  await service.switchReasoning("logical-a", "high");
  assert.deepEqual(calls.map((call) => call[0]), ["interrupt", "respondToApproval", "switchModel", "switchReasoning"]);
});

test("Session application service preserves structured unsupported-capability errors", async () => {
  const { service } = fixture([AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]);
  await assert.rejects(
    () => service.interrupt("logical-a"),
    (error) => error instanceof AgentProviderCapabilityError
      && error.capability === AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT
  );
});

test("Session application service rejects unresolved logical Sessions", async () => {
  const { service } = fixture();
  await assert.rejects(
    () => service.readSession("missing"),
    (error) => error instanceof SessionNotFoundError && error.code === "SESSION_NOT_FOUND"
  );
});
