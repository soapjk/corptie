import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES, AgentProviderCapabilityError } from "../src/agent-provider/contracts.mjs";
import { SessionApplicationService, SessionNotFoundError } from "../src/agent-provider/sessionApplicationService.mjs";

function fixture(capabilities = [
  AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE
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
    createSession: async (...args) => {
      calls.push(["createSession", ...args]);
      return { id: "legacy-created", title: "Created" };
    },
    resumeSession: async (...args) => {
      calls.push(["resumeSession", ...args]);
      return { id: "legacy-a", title: "Resumed" };
    },
    deleteSession: async (...args) => {
      calls.push(["deleteSession", ...args]);
      return true;
    },
    listModels: async (...args) => {
      calls.push(["listModels", ...args]);
      return { models: [{ id: "fake-model" }] };
    },
    send: async (...args) => calls.push(["send", ...args]),
    interrupt: async (...args) => calls.push(["interrupt", ...args]),
    respondToApproval: async (...args) => calls.push(["respondToApproval", ...args]),
    switchModel: async (...args) => calls.push(["switchModel", ...args]),
    switchReasoning: async (...args) => calls.push(["switchReasoning", ...args]),
    updatePermissions: async (...args) => calls.push(["updatePermissions", ...args])
  });
  const registry = new AgentProviderRegistry([provider]);
  const service = new SessionApplicationService({
    registry,
    resolveSessionReference: async (sessionId) => sessionId === "logical-a"
      ? {
          bindingId: "binding-a",
          logicalSessionId: "logical-a",
          sessionId: "legacy-a",
          providerId: "fake.provider",
          providerSessionId: "native-a",
          routingVersion: 3
        }
      : null,
    resolveSessionBinding: async (sessionId, bindingId) => sessionId === "logical-a" && bindingId === "binding-old"
      ? {
          sessionId: "legacy-a",
          logicalSessionId: "logical-a",
          bindingId,
          providerId: "fake.provider",
          providerSessionId: "native-old"
        }
      : null,
    bindCreatedSession: async ({ providerId, session }) => {
      calls.push(["bindCreatedSession", providerId, session.id]);
      return {
        sessionId: session.id,
        logicalSessionId: "logical-created"
      };
    },
    removeSessionBinding: async ({ reference }) => {
      calls.push(["removeSessionBinding", reference.sessionId]);
    }
  });
  return { calls, registry, service };
}

test("Session application service resolves stable logical ids before Provider calls", async () => {
  const { calls, service } = fixture();
  await service.sendMessage("logical-a", "hello", { source: "desktop" });
  assert.deepEqual(calls, [[
    "send",
    {
      sessionId: "legacy-a",
      requestedSessionId: "logical-a",
      logicalSessionId: "logical-a",
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

test("Session application service owns Provider-neutral lifecycle and stable identity", async () => {
  const { calls, service } = fixture();
  const created = await service.createSession("fake.provider", { cwd: "/tmp/project" }, { source: "desktop" });
  assert.equal(created.id, "legacy-created");
  assert.equal(created.logicalSessionId, "logical-created");
  assert.equal(created.publicSessionId, "logical-created");
  assert.equal(created.actions.send.available, true);

  const resumed = await service.resumeSession("logical-a", { source: "desktop" });
  assert.equal(resumed.title, "Resumed");
  const deleted = await service.deleteSession("logical-a", { source: "desktop" });
  assert.deepEqual(deleted, {
    ok: true,
    deleted: true,
    sessionId: "legacy-a",
    logicalSessionId: "logical-a",
    providerId: "fake.provider"
  });
  assert.deepEqual(calls.map((call) => call[0]), [
    "createSession",
    "bindCreatedSession",
    "resumeSession",
    "deleteSession",
    "removeSessionBinding"
  ]);
});

test("Session application service exposes Provider model catalogs through capability dispatch", async () => {
  const { calls, service } = fixture();
  const result = await service.listModels("fake.provider", { refresh: true });
  assert.deepEqual(result, { models: [{ id: "fake-model" }] });
  assert.deepEqual(calls, [["listModels", { refresh: true }]]);
});

test("Session application service exposes the same operations for every Provider", async () => {
  const { calls, service } = fixture();
  const detail = await service.readSession("logical-a");
  assert.equal(detail.id, "legacy-a");
  assert.equal(detail.source, "fake.provider");
  assert.equal(detail.actions.send.available, true);
  assert.equal(detail.actions.interrupt.reason, "NO_ACTIVE_TURN");
  await service.interrupt("logical-a", { source: "desktop" });
  await service.respondToApproval("logical-a", { approved: true });
  await service.switchModel("logical-a", "fake-model");
  await service.switchReasoning("logical-a", "high");
  await service.updatePermissions("logical-a", { sandbox: "read-only" });
  assert.deepEqual(calls.map((call) => call[0]), ["interrupt", "respondToApproval", "switchModel", "switchReasoning", "updatePermissions"]);
});

test("Session application service reads historical bindings through their recorded Provider", async () => {
  const { service } = fixture();
  const detail = await service.readSessionBinding("logical-a", "binding-old");
  assert.equal(detail.id, "legacy-a");
  assert.equal(detail.source, "fake.provider");
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
