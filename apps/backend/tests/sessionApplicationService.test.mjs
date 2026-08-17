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
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
  AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_AVATAR_UPDATE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_CLEAR,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE,
  AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ,
  AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ,
  AGENT_PROVIDER_CAPABILITIES.TURN_CHANGES_MANAGE
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
    restartSession: async (...args) => {
      calls.push(["restartSession", ...args]);
      return { status: "completed" };
    },
    disconnectSession: async (...args) => {
      calls.push(["disconnectSession", ...args]);
      return { status: "disconnected" };
    },
    renameSession: async (...args) => {
      calls.push(["renameSession", ...args]);
      return { title: args[1] };
    },
    updateAvatar: async (...args) => {
      calls.push(["updateAvatar", ...args]);
      return { avatarPath: args[1] };
    },
    listModels: async (...args) => {
      calls.push(["listModels", ...args]);
      return { models: [{ id: "fake-model" }] };
    },
    send: async (...args) => calls.push(["send", ...args]),
    clearConversation: async (...args) => {
      calls.push(["clearConversation", ...args]);
      return { id: "legacy-a", title: "Cleared" };
    },
    interrupt: async (...args) => calls.push(["interrupt", ...args]),
    respondToApproval: async (...args) => calls.push(["respondToApproval", ...args]),
    switchModel: async (...args) => calls.push(["switchModel", ...args]),
    switchReasoning: async (...args) => calls.push(["switchReasoning", ...args]),
    updatePermissions: async (...args) => calls.push(["updatePermissions", ...args]),
    readAccountUsage: async (...args) => {
      calls.push(["readAccountUsage", ...args]);
      return { provider: "fake", available: true };
    },
    readSessionUsage: async (...args) => {
      calls.push(["readSessionUsage", ...args]);
      return { usedTokens: 10, contextWindow: 100 };
    },
    manageTurnChanges: async (...args) => calls.push(["manageTurnChanges", ...args])
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
    },
    persistRenamedSession: async ({ reference, title, providerSession }) => {
      calls.push(["persistRenamedSession", reference.sessionId, title]);
      return { ...providerSession, id: reference.sessionId, title };
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

test("Session application service resolves context once and passes it through the common Provider contract", async () => {
  const { calls, registry } = fixture();
  const service = new SessionApplicationService({
    registry,
    resolveSessionReference: async () => ({
      sessionId: "legacy-a",
      providerId: "fake.provider",
      providerSessionId: "native-a"
    }),
    resolveMessageContext: async (reference) => ({
      prompt: `Context for ${reference.sessionId}`,
      documents: [{ referenceId: "ref-a" }]
    })
  });

  await service.sendMessage("legacy-a", "hello", { source: "desktop" });

  assert.equal(calls[0][0], "send");
  assert.equal(calls[0][2], "hello");
  assert.deepEqual(calls[0][3].sessionContext, {
    prompt: "Context for legacy-a",
    documents: [{ referenceId: "ref-a" }]
  });
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
  assert.deepEqual(await service.restartSession("logical-a"), { status: "completed" });
  assert.deepEqual(await service.disconnectSession("logical-a"), { status: "disconnected" });
  assert.deepEqual(await service.renameSession("logical-a", "Renamed"), { id: "legacy-a", title: "Renamed" });
  assert.deepEqual(await service.updateAvatar("logical-a", "/tmp/avatar.png"), { avatarPath: "/tmp/avatar.png" });
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
    "restartSession",
    "disconnectSession",
    "renameSession",
    "persistRenamedSession",
    "updateAvatar",
    "deleteSession",
    "removeSessionBinding"
  ]);
});

test("Session application service lets each Provider prepare create input", async () => {
  const calls = [];
  const provider = new CallbackAgentProvider({
    id: "third-party",
    displayName: "Third Party",
    transport: "http",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE]
  }, {
    prepareSessionInput: async (input, context) => {
      calls.push(["prepareSessionInput", input, context]);
      return { ...input, model: "provider-default", normalized: true };
    },
    createSession: async (input, context) => {
      calls.push(["createSession", input, context]);
      return { id: "third-party-session" };
    }
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => null,
    bindCreatedSession: async (input) => {
      calls.push(["bindCreatedSession", input]);
      return { logicalSessionId: "logical-third-party" };
    }
  });

  const session = await service.createSession(
    "third-party",
    { cwd: "/tmp/project" },
    { source: "desktop" }
  );

  assert.equal(session.logicalSessionId, "logical-third-party");
  assert.deepEqual(calls[0], [
    "prepareSessionInput",
    { cwd: "/tmp/project" },
    { source: "desktop" }
  ]);
  assert.deepEqual(calls[1], [
    "createSession",
    { cwd: "/tmp/project", model: "provider-default", normalized: true },
    { source: "desktop" }
  ]);
  assert.deepEqual(calls[2][1].input, {
    cwd: "/tmp/project",
    model: "provider-default",
    normalized: true
  });
});

test("Session creation preserves Agent actor context for Providers without Tool Host support", async () => {
  const calls = [];
  const provider = new CallbackAgentProvider({
    id: "external-provider",
    displayName: "External Provider",
    transport: "http",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE]
  }, {
    createSession: async () => ({ id: "external-session" })
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => null,
    bindCreatedSession: async ({ context }) => {
      calls.push(context.actorId);
      return { logicalSessionId: "logical-external" };
    }
  });

  const session = await service.createSession(
    "external-provider",
    { cwd: "/tmp/external" },
    { source: "agent", actorId: "agent:external" }
  );

  assert.equal(session.logicalSessionId, "logical-external");
  assert.deepEqual(calls, ["agent:external"]);
});

test("Session application service exposes Provider model catalogs through capability dispatch", async () => {
  const { calls, service } = fixture();
  const result = await service.listModels("fake.provider", { refresh: true });
  assert.deepEqual(result, { models: [{ id: "fake-model" }] });
  assert.deepEqual(calls, [["listModels", { refresh: true }]]);
});

test("Session application service resolves model catalogs through the Session Provider", async () => {
  const { calls, service } = fixture();
  const result = await service.listModelsForSession("logical-a", { source: "dsh" });
  assert.deepEqual(result, {
    providerId: "fake.provider",
    providerName: "Fake Provider",
    models: [{ id: "fake-model" }],
    currentModel: null,
    currentReasoningLevel: null
  });
  assert.deepEqual(calls, [["listModels", { source: "dsh" }]]);
});

test("Session application service routes account and context usage through the active Provider", async () => {
  const { calls, service } = fixture();
  assert.deepEqual(await service.readAccountUsage("logical-a"), { provider: "fake", available: true });
  assert.deepEqual(await service.readSessionUsage("logical-a"), { usedTokens: 10, contextWindow: 100 });
  assert.deepEqual(calls.map((call) => call[0]), ["readAccountUsage", "readSessionUsage"]);
  assert.equal(calls[0][1].providerSessionId, "native-a");
  assert.equal(calls[1][1].providerSessionId, "native-a");
});

test("Session application service exposes the same operations for every Provider", async () => {
  const { calls, service } = fixture();
  const detail = await service.readSession("logical-a");
  assert.equal(detail.id, "legacy-a");
  assert.equal(detail.source, "fake.provider");
  assert.equal(detail.actions.send.available, true);
  assert.equal(detail.actions.interrupt.reason, "NO_ACTIVE_TURN");
  await service.interrupt("logical-a", { source: "desktop" });
  assert.deepEqual(await service.clearConversation("logical-a", { source: "desktop" }), {
    id: "legacy-a",
    title: "Cleared"
  });
  await service.respondToApproval("logical-a", { approved: true });
  await service.switchModel("logical-a", "fake-model");
  await service.switchReasoning("logical-a", "high");
  await service.updatePermissions("logical-a", { sandbox: "read-only" });
  await service.manageTurnChanges("logical-a", "turn-a", "review", { source: "desktop" });
  assert.deepEqual(calls.map((call) => call[0]), [
    "interrupt",
    "clearConversation",
    "respondToApproval",
    "switchModel",
    "switchReasoning",
    "updatePermissions",
    "manageTurnChanges"
  ]);
  assert.deepEqual(calls.at(-1).slice(1), [
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
    "turn-a",
    "review",
    { source: "desktop" }
  ]);
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
