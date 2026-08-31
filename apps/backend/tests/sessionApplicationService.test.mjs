import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES, AgentProviderCapabilityError } from "../src/agent-provider/contracts.mjs";
import {
  SessionApplicationService,
  SessionNotFoundError,
  validateReasoningLevelForModel
} from "../src/agent-provider/sessionApplicationService.mjs";

function fixture(capabilities = [
  AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
  AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE,
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
    prepareExecution: async (...args) => {
      calls.push(["prepareExecution", ...args]);
      return { prepared: true };
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

test("Session application service rejects dispatch while the shared route boundary is recovering", async () => {
  const { calls, registry } = fixture();
  const service = new SessionApplicationService({
    registry,
    resolveSessionReference: async () => ({
      sessionId: "legacy-a",
      logicalSessionId: "logical-a",
      providerId: "fake.provider",
      providerSessionId: "native-a"
    }),
    assertMessageDispatchAllowed: () => {
      const error = new Error("The Session is recovering.");
      error.code = "SESSION_BUSY";
      throw error;
    }
  });
  await assert.rejects(
    service.sendMessage("logical-a", "must not dispatch"),
    { code: "SESSION_BUSY" }
  );
  assert.deepEqual(calls, []);
});

test("Session application service prepares execution through the Provider-neutral contract", async () => {
  const { calls, service } = fixture();
  const preparation = await service.prepareExecution("logical-a", { source: "session-selection" });

  assert.deepEqual(preparation, { prepared: true });
  assert.equal(calls[0][0], "prepareExecution");
  assert.equal(calls[0][1].providerId, "fake.provider");
  assert.equal(calls[0][1].providerSessionId, "native-a");
  assert.equal(calls[0][2].source, "session-selection");
  assert.equal(calls[0][2].purpose, "session");
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
    "deleteSession",
    "removeSessionBinding"
  ]);
});

test("new Session finalizes Tool Host with the authoritative binding before returning", async () => {
  const calls = [];
  const toolHostContexts = [];
  const provider = new CallbackAgentProvider({
    id: "tool-host-provider",
    displayName: "Tool Host Provider",
    transport: "fake",
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
    ]
  }, {
    createSession: async (input) => {
      calls.push(["create", input.toolHost.providerAttachment.phase]);
      return { id: "session:new" };
    },
    resumeSession: async (reference, context) => {
      calls.push(["finalize", reference.sessionId, context.toolHost.providerAttachment.phase]);
      return { id: reference.sessionId };
    },
    attachTools: async () => ({})
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveRequiredToolDomains: (context) => context.sessionKind === "worker" ? ["artifacts"] : [],
    toolMaterializationPort: {
      async ensureDomainsApplied(logicalSessionId, domains, boundary) {
        calls.push(["ensure", logicalSessionId, domains, boundary]);
        return { appliedDomains: domains };
      }
    },
    toolHostService: {
      async prepareSession(_providerId, context) {
        toolHostContexts.push(context);
        return {
          actorId: context.actorId,
          providerAttachment: {
            phase: context.sessionId ? "authenticated" : "bootstrap"
          }
        };
      }
    },
    resolveSessionReference: async () => null,
    bindCreatedSession: async ({ session }) => {
      calls.push(["bind", session.id]);
      return {
        sessionId: session.id,
        logicalSessionId: "logical:new",
        bindingId: "binding:new",
        providerId: "tool-host-provider",
        providerSessionId: "native:new"
      };
    }
  });

  const created = await service.createSession(
    "tool-host-provider",
    { sessionKind: "worker" },
    {
      actorId: "agent:one",
      objectiveId: "objective:one",
      workItemId: "work_item:one",
      sessionKind: "worker"
    }
  );

  assert.equal(created.logicalSessionId, "logical:new");
  assert.deepEqual(calls, [
    ["create", "bootstrap"],
    ["bind", "session:new"],
    ["ensure", "logical:new", ["artifacts"], {
      turnExecutionId: null,
      purpose: "session-create-finalization"
    }],
    ["finalize", "session:new", "authenticated"]
  ]);
  assert.equal(toolHostContexts[0].purpose, "session-bootstrap");
  assert.equal(toolHostContexts[0].sessionId, undefined);
  assert.deepEqual(toolHostContexts[1], {
    actorId: "agent:one",
    objectiveId: "objective:one",
    workItemId: "work_item:one",
    sessionKind: "worker",
    purpose: "session-create-finalization",
    sessionId: "session:new",
    logicalSessionId: "logical:new",
    providerBindingId: "binding:new"
  });
});

test("new Session fails closed when authenticated Tool Host finalization fails", async () => {
  let preparations = 0;
  const provider = new CallbackAgentProvider({
    id: "failing-tool-host-provider",
    displayName: "Failing Tool Host Provider",
    transport: "fake",
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
    ]
  }, {
    createSession: async () => ({ id: "session:degraded" }),
    resumeSession: async () => ({ id: "must-not-resume" }),
    attachTools: async () => ({})
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    toolHostService: {
      async prepareSession(_providerId, context) {
        preparations += 1;
        if (context.sessionId) throw Object.assign(new Error("MCP unavailable"), { code: "MCP_LOADING_FAILED" });
        return { actorId: context.actorId, providerAttachment: {} };
      }
    },
    resolveSessionReference: async () => null,
    bindCreatedSession: async ({ session }) => ({
      sessionId: session.id,
      logicalSessionId: "logical:degraded",
      providerId: "failing-tool-host-provider",
      providerSessionId: "native:degraded"
    })
  });

  await assert.rejects(
    service.createSession("failing-tool-host-provider", {}, { actorId: "agent:one", sessionKind: "worker" }),
    (error) => error.code === "SESSION_TOOL_MATERIALIZATION_FAILED"
      && error.stage === "tool_host_finalization"
      && error.cause?.code === "MCP_LOADING_FAILED"
  );
  assert.equal(preparations, 2);
});

test("authoritative startup can defer Tool Host finalization until its ready commit", async () => {
  const calls = [];
  const provider = new CallbackAgentProvider({
    id: "deferred-tool-host-provider",
    displayName: "Deferred Tool Host Provider",
    transport: "fake",
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
    ]
  }, {
    createSession: async () => { calls.push("create"); return { id: "session:deferred" }; },
    resumeSession: async () => { calls.push("resume"); return { id: "session:deferred" }; },
    attachTools: async () => ({})
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    toolHostService: {
      async prepareSession(_providerId, context) {
        calls.push(context.purpose);
        return { actorId: context.actorId, providerAttachment: {} };
      }
    },
    resolveSessionReference: async () => null,
    bindCreatedSession: async ({ session }) => {
      calls.push("bind");
      return {
        sessionId: session.id,
        logicalSessionId: "logical:deferred",
        providerId: "deferred-tool-host-provider",
        providerSessionId: "native:deferred"
      };
    }
  });

  const created = await service.createSession(
    "deferred-tool-host-provider",
    { sessionKind: "worker" },
    { actorId: "agent:one", sessionKind: "worker", deferToolHostFinalization: true }
  );

  assert.equal(created.logicalSessionId, "logical:deferred");
  assert.deepEqual(calls, ["session-bootstrap", "create", "bind"]);
});

test("deferred startup finalization preserves its Provider lifecycle purpose", async () => {
  let resumeContext = null;
  const capabilities = [
    AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
    AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
  ];
  const provider = new CallbackAgentProvider({
    id: "startup-finalization-provider",
    displayName: "Startup Finalization Provider",
    transport: "fake",
    capabilities
  }, {
    resumeSession: async (_reference, context) => {
      resumeContext = context;
      return { id: "session:ready" };
    },
    attachTools: async () => ({})
  });
  const reference = {
    sessionId: "session:ready",
    logicalSessionId: "logical:ready",
    providerId: "startup-finalization-provider",
    providerSessionId: "native:ready",
    metadata: { session: { id: "session:ready", agentId: "agent:one", sessionKind: "worker" } }
  };
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => reference,
    toolHostService: {
      async prepareSession() { return { actorId: "agent:one", providerAttachment: {} }; }
    }
  });

  await service.resumeSession("session:ready", { purpose: "session-create-finalization" });

  assert.equal(resumeContext.purpose, "session-create-finalization");
});

test("unusable replacement cleanup removes the local Session even when the Provider thread is already missing", async () => {
  const calls = [];
  const provider = new CallbackAgentProvider({
    id: "missing-session-provider",
    displayName: "Missing Session Provider",
    transport: "fake",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE]
  }, {
    deleteSession: async () => {
      const error = new Error("Provider Session no longer exists");
      error.code = "PROVIDER_SESSION_UNAVAILABLE";
      throw error;
    }
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => ({
      sessionId: "legacy-missing",
      logicalSessionId: "logical-missing",
      providerId: "missing-session-provider",
      providerSessionId: "native-missing"
    }),
    removeSessionBinding: async ({ reference, providerError }) => {
      calls.push(["removeSessionBinding", reference.sessionId, providerError.code]);
    }
  });

  const deleted = await service.deleteUnusableSession("logical-missing", {
    source: "work-item-self-repair",
    replacementSessionId: "legacy-replacement"
  });

  assert.deepEqual(deleted, {
    ok: true,
    deleted: true,
    sessionId: "legacy-missing",
    logicalSessionId: "logical-missing",
    providerId: "missing-session-provider",
    providerDeleted: false,
    providerErrorCode: "PROVIDER_SESSION_UNAVAILABLE"
  });
  assert.deepEqual(calls, [[
    "removeSessionBinding",
    "legacy-missing",
    "PROVIDER_SESSION_UNAVAILABLE"
  ]]);
});

test("Provider deletion and product binding removal remain separate lifecycle steps", async () => {
  const calls = [];
  const provider = new CallbackAgentProvider({
    id: "delete-boundary",
    displayName: "Delete Boundary",
    transport: "fake",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE]
  }, {
    deleteSession: async () => { calls.push("provider-delete"); return true; }
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => ({
      sessionId: "session:delete-boundary", logicalSessionId: "logical:delete-boundary",
      bindingId: "binding:delete-boundary", providerId: "delete-boundary",
      providerSessionId: "native:delete-boundary", routingVersion: 1
    }),
    removeSessionBinding: async () => { calls.push("product-binding-delete"); }
  });

  await service.deleteSession("logical:delete-boundary");
  assert.deepEqual(calls, ["provider-delete", "product-binding-delete"]);
});

test("Session recovery rebuilds and passes the Provider-neutral Tool Host attachment", async () => {
  const calls = [];
  const provider = new CallbackAgentProvider({
    id: "recoverable",
    displayName: "Recoverable",
    transport: "fake",
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
      AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES
    ]
  }, {
    listSessions: () => [],
    readSession: () => null,
    attachTools: (attachment) => attachment,
    resumeSession: (reference, context) => {
      calls.push({ reference, context });
      return { id: reference.sessionId, title: "Recovered" };
    }
  });
  const toolHostCalls = [];
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    toolHostService: {
      async prepareSession(providerId, context) {
        toolHostCalls.push({ providerId, context });
        return {
          actorId: context.actorId,
          providerAttachment: {
            dynamicToolAgentId: context.actorId,
            config: { mcp_servers: { investrace: { command: "node" } } }
          }
        };
      }
    },
    resolveSessionReference: async () => ({
      sessionId: "session:recover",
      providerId: "recoverable",
      providerSessionId: "native:recover",
      metadata: {
        session: {
          agentId: "agent:investor",
          sessionKind: "assistantChat"
        }
      }
    })
  });

  const resumed = await service.resumeSession("session:recover", { source: "desktop" });
  assert.equal(resumed.title, "Recovered");
  assert.equal(toolHostCalls.length, 1);
  assert.equal(toolHostCalls[0].context.purpose, "session-resume");
  assert.equal(toolHostCalls[0].context.actorId, "agent:investor");
  assert.equal(calls[0].context.toolHost.providerAttachment.config.mcp_servers.investrace.command, "node");
});

test("an unavailable Provider binding is replaced and an unsent message is retried exactly once", async () => {
  const sends = [];
  let currentReference = {
    sessionId: "session:recover-send",
    logicalSessionId: "logical:recover-send",
    bindingId: "binding:failed",
    providerId: "recoverable-send",
    providerSessionId: "native:failed",
    routingVersion: 1
  };
  const provider = new CallbackAgentProvider({
    id: "recoverable-send",
    displayName: "Recoverable Send",
    transport: "fake",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]
  }, {
    send: async (reference, message) => {
      sends.push({ reference, message });
      if (reference.bindingId === "binding:failed") {
        const error = new Error("physical Provider Session failed during initialization");
        error.code = "PROVIDER_SESSION_UNAVAILABLE";
        error.dispatchState = "not_sent";
        error.recoveryAction = "replace_provider_binding";
        throw error;
      }
      return { turn: { id: "turn:recovered" } };
    }
  });
  const recoveries = [];
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => currentReference,
    recoverUnavailableSession: async (input) => {
      recoveries.push(input);
      currentReference = {
        ...currentReference,
        bindingId: "binding:recovered",
        providerSessionId: "native:recovered",
        routingVersion: 2
      };
      return { reference: currentReference };
    }
  });

  const result = await service.sendMessage("logical:recover-send", "send once", {
    idempotencyKey: "delivery:recover-send"
  });

  assert.equal(result.turn.id, "turn:recovered");
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].error.dispatchState, "not_sent");
  assert.deepEqual(sends.map((entry) => entry.reference.bindingId), ["binding:failed", "binding:recovered"]);
  assert.deepEqual(sends.map((entry) => entry.message), ["send once", "send once"]);
});

test("restart replaces an unconfirmed Tool schema binding exactly once without creating a Turn", async () => {
  const restartCalls = [];
  const recoveries = [];
  let currentReference = {
    sessionId: "session:restart-recovery",
    logicalSessionId: "logical:restart-recovery",
    bindingId: "binding:old",
    providerId: "restart-recovery",
    providerSessionId: "native:old",
    routingVersion: 4
  };
  const provider = new CallbackAgentProvider({
    id: "restart-recovery",
    displayName: "Restart Recovery",
    transport: "fake",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART]
  }, {
    restartSession: async (reference) => {
      restartCalls.push(reference);
      const error = new Error("Provider did not confirm the current Tool schema.");
      error.code = "SESSION_TOOL_CATALOG_REFRESH_FAILED";
      error.dispatchState = "not_sent";
      error.recoveryAction = "replace_provider_binding";
      error.replacementReason = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
      throw error;
    }
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => currentReference,
    recoverUnavailableSession: async (input) => {
      recoveries.push(input);
      currentReference = {
        ...currentReference,
        bindingId: "binding:new",
        providerSessionId: "native:new",
        routingVersion: 5
      };
      return { reference: currentReference };
    }
  });

  const result = await service.restartSession("logical:restart-recovery", {
    idempotencyKey: "session-restart:test"
  });

  assert.equal(restartCalls.length, 1);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].context.recoveryKind, "restart");
  assert.equal(recoveries[0].error.replacementReason, "PROVIDER_TOOL_APPLICATION_UNCONFIRMED");
  assert.deepEqual(result, {
    status: "completed",
    recovered: true,
    recoveryAction: "provider_binding_replaced",
    sessionId: "session:restart-recovery",
    logicalSessionId: "logical:restart-recovery",
    providerBindingId: "binding:new",
    routingVersion: 5
  });
});

test("restart never replaces a binding after an outcome-unknown failure", async () => {
  let recoveries = 0;
  const provider = new CallbackAgentProvider({
    id: "restart-unknown",
    displayName: "Restart Unknown",
    transport: "fake",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART]
  }, {
    restartSession: async () => {
      const error = new Error("Provider may have restarted the Session.");
      error.code = "RESTART_OUTCOME_UNKNOWN";
      error.dispatchState = "delivery_unknown";
      error.recoveryAction = "replace_provider_binding";
      throw error;
    }
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => ({
      sessionId: "session:restart-unknown",
      logicalSessionId: "logical:restart-unknown",
      bindingId: "binding:unknown",
      providerId: "restart-unknown",
      providerSessionId: "native:unknown",
      routingVersion: 1
    }),
    recoverUnavailableSession: async () => { recoveries += 1; }
  });

  await assert.rejects(
    service.restartSession("logical:restart-unknown", { idempotencyKey: "session-restart:unknown" }),
    { code: "RESTART_OUTCOME_UNKNOWN" }
  );
  assert.equal(recoveries, 0);
});

test("delivery_unknown is never recovered or retried automatically", async () => {
  let recoveries = 0;
  let sends = 0;
  const provider = new CallbackAgentProvider({
    id: "unknown-delivery",
    displayName: "Unknown Delivery",
    transport: "fake",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]
  }, {
    send: async () => {
      sends += 1;
      const error = new Error("connection ended after request bytes may have been accepted");
      error.code = "DELIVERY_UNKNOWN";
      error.dispatchState = "delivery_unknown";
      error.recoveryAction = "replace_provider_binding";
      throw error;
    }
  });
  const service = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async () => ({
      sessionId: "session:unknown", logicalSessionId: "logical:unknown",
      bindingId: "binding:unknown", providerId: "unknown-delivery",
      providerSessionId: "native:unknown", routingVersion: 1
    }),
    recoverUnavailableSession: async () => { recoveries += 1; }
  });

  await assert.rejects(
    service.sendMessage("logical:unknown", "do not duplicate", { idempotencyKey: "delivery:unknown" }),
    { code: "DELIVERY_UNKNOWN" }
  );
  assert.equal(sends, 1);
  assert.equal(recoveries, 0);
});

test("Session application service rejects retired per-session avatar input", async () => {
  const { service } = fixture();
  await assert.rejects(
    service.createSession("fake.provider", { cwd: "/tmp/project", avatarPath: "/tmp/avatar.png" }),
    (error) => error?.code === "SESSION_AVATAR_UNSUPPORTED"
  );
});

test("route-transition creation returns a Provider thread without binding a second logical Session", async () => {
  const { calls, service } = fixture();
  const session = await service.createSessionForRouteTransition(
    "fake.provider",
    { cwd: "/tmp/project", title: "Existing logical title" },
    { actorId: "agent-a", sessionKind: "assistantChat" }
  );

  assert.equal(session.id, "legacy-created");
  assert.deepEqual(calls.map((call) => call[0]), ["createSession"]);
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

test("reasoning selection rejects values outside the current model catalog", () => {
  assert.equal(validateReasoningLevelForModel({
    modelId: "fake-model",
    reasoningLevel: "high",
    models: [{ id: "fake-model", reasoningLevels: ["low", "high"] }]
  }), "high");
  assert.throws(() => validateReasoningLevelForModel({
    modelId: "fake-model",
    reasoningLevel: "max",
    models: [{ id: "fake-model", reasoningLevels: ["low", "high"] }]
  }), (error) => error.code === "UNSUPPORTED_REASONING_LEVEL");
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
    () => service.interrupt("missing"),
    (error) => error instanceof SessionNotFoundError && error.code === "SESSION_NOT_FOUND"
  );
});
