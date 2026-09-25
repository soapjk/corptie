import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { createClaudeProviderRuntime } from "../src/agent-provider/bootstrap/claudeProviderBootstrap.mjs";
import { createAgentProviderRuntimeRegistry } from "../src/agent-provider/bootstrap/agentProviderBootstrap.mjs";
import { CodexProviderRuntime } from "../src/agent-provider/bootstrap/codexProviderRuntime.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { executeCodexSlashCommand } from "../src/adapters/codexSlashCommands.mjs";
import { parseSlashCommand } from "../src/commands/unifiedCommands.mjs";

test("production bootstrap routes slash goal through the application service to native RPC", async () => {
  const calls = [];
  const runtime = new CodexProviderRuntime({ client: {
    executeCommand: (threadId, command) => executeCodexSlashCommand(async (method, params) => {
      calls.push({ method, params });
      return { goal: { objective: params.objective, status: params.status, tokensUsed: 0 } };
    }, threadId, command)
  } });
  const registry = createAgentProviderRuntimeRegistry({
    claudeProvider: createClaudeAgentSdkProvider(recordingManager()),
    codexOperations: {
      ...recordingCodexOperations(),
      send: () => assert.fail("commands must not dispatch an ordinary message"),
      executeCommand: (reference, command) => runtime.executeCommand(reference.providerSessionId, command)
    }
  });
  const service = new SessionApplicationService({ registry, resolveSessionReference: () => ({
    sessionId: "session:test", providerId: "codex-app-server", providerSessionId: "thread:test"
  }) });
  const result = await service.executeCommand("session:test", parseSlashCommand("/goal 完成剩余任务"));
  const commands = await service.listConversationCommands("session:test");
  assert.equal(commands.find(command => command.name === "goal").available, true);
  assert.deepEqual(calls, [{ method: "thread/goal/set", params: {
    threadId: "thread:test", objective: "完成剩余任务", status: "active"
  } }]);
  assert.match(result.text, /完成剩余任务/);
  assert.equal(registry.supports("claude-sdk", AGENT_PROVIDER_CAPABILITIES.CONVERSATION_COMMAND), false);
});

test("shared catalog and common commands work without a Provider-specific command adapter", async () => {
  const manager = recordingManager();
  const registry = new AgentProviderRegistry([createClaudeAgentSdkProvider(manager)]);
  const service = new SessionApplicationService({ registry, resolveSessionReference: () => ({
    sessionId: "session:claude", providerId: "claude-sdk", providerSessionId: "native:claude",
    metadata: { session: { status: "complete" } }
  }) });
  const commands = await service.listConversationCommands("session:claude");
  assert.equal(commands.find(command => command.name === "goal").available, false);
  assert.equal(commands.find(command => command.name === "status").available, true);
  assert.equal(commands.find(command => command.name === "rename").available, true);
  await assert.rejects(service.validateConversationCommand("session:claude", { name: "goal", arguments: "build" }), { code: "CAPABILITY_UNSUPPORTED" });
  assert.match((await service.executeCommand("session:claude", { name: "status", arguments: "" })).text, /complete/);
  await service.executeCommand("session:claude", { name: "rename", arguments: "new title" });
  assert.deepEqual(manager.calls, [["rename", "native:claude", "new title"]]);
});

test("bootstrap does not advertise command execution without an implementation", () => {
  const registry = createAgentProviderRuntimeRegistry({
    claudeProvider: createClaudeAgentSdkProvider(recordingManager()),
    codexOperations: recordingCodexOperations()
  });
  assert.equal(registry.supports("codex-app-server", AGENT_PROVIDER_CAPABILITIES.CONVERSATION_COMMAND), false);
});

test("structured plan output is declared only by Providers whose adapters enable it", () => {
  const registry = createAgentProviderRuntimeRegistry({
    claudeProvider: createClaudeAgentSdkProvider(recordingManager()),
    codexOperations: recordingCodexOperations()
  });
  assert.equal(registry.supports("codex-app-server", AGENT_PROVIDER_CAPABILITIES.EXECUTION_PLAN_EVENTS), true);
  assert.equal(registry.supports("claude-sdk", AGENT_PROVIDER_CAPABILITIES.EXECUTION_PLAN_EVENTS), true);
  const disabledClaude = createClaudeAgentSdkProvider(recordingManager(), { structuredPlanEvents: false });
  assert.equal(disabledClaude.descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.EXECUTION_PLAN_EVENTS), false);
  const disabledRuntime = createClaudeProviderRuntime({ store: {}, structuredPlanEvents: false });
  assert.equal(disabledRuntime.manager.structuredPlanEvents, false);
  assert.equal(disabledRuntime.descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.EXECUTION_PLAN_EVENTS), false);
  assert.throws(() => createClaudeAgentSdkProvider(disabledRuntime.manager, { structuredPlanEvents: true }),
    /declaration must match/);
});

test("multi-question input dispatches only through a declared Provider capability", async () => {
  const calls = [];
  const registry = createAgentProviderRuntimeRegistry({
    claudeProvider: createClaudeAgentSdkProvider(recordingManager()),
    codexOperations: {
      ...recordingCodexOperations(),
      respondToUserInput: (reference, input) => {
        calls.push({ providerSessionId: reference.providerSessionId, input });
        return { ok: true };
      }
    }
  });
  assert.equal(registry.supports("codex-app-server", AGENT_PROVIDER_CAPABILITIES.CONVERSATION_USER_INPUT), true);
  assert.equal(registry.supports("claude-sdk", AGENT_PROVIDER_CAPABILITIES.CONVERSATION_USER_INPUT), false);
  const service = new SessionApplicationService({ registry, resolveSessionReference: () => ({
    sessionId: "session:one", providerId: "codex-app-server", providerSessionId: "thread:one"
  }) });
  const input = { itemId: "input:one", answers: { route: ["A"] } };
  await service.respondToUserInput("session:one", input);
  assert.deepEqual(calls, [{ providerSessionId: "thread:one", input }]);
  const unsupported = new SessionApplicationService({ registry, resolveSessionReference: () => ({
    sessionId: "session:claude", providerId: "claude-sdk", providerSessionId: "claude:one"
  }) });
  await assert.rejects(unsupported.respondToUserInput("session:claude", input), {
    code: "CAPABILITY_UNSUPPORTED"
  });
});

function recordingManager(provider = "claude-sdk") {
  const calls = [];
  const manager = {
    calls,
    list: (options) => [{ id: `pty:${provider}-a`, external: { provider }, options }],
    detail: (id) => ({ id }),
    read: (id) => ({ id }),
    start: (input) => calls.push(["start", input]),
    reconnect: (id) => calls.push(["reconnect", id]),
    delete: (id) => calls.push(["delete", id]),
    rename: (id, title) => calls.push(["rename", id, title]),
    disconnect: (id) => calls.push(["disconnect", id]),
    send: (id, message) => calls.push(["send", id, message]),
    write: (id, message, options) => calls.push(["write", id, message, options]),
    interrupt: (id) => calls.push(["interrupt", id]),
    respondToChoice: (id, input) => calls.push(["choice", id, input]),
    switchModel: (id, model) => calls.push(["model", id, model]),
    switchReasoning: (id, level) => calls.push(["reasoning", id, level])
  };
  return manager;
}

test("Claude manager is isolated behind the common Agent Provider contract", async () => {
  const manager = recordingManager();
  const provider = createClaudeAgentSdkProvider(manager);
  const registry = new AgentProviderRegistry([provider]);
  const reference = { providerSessionId: "claude-native-a" };
  await registry.invoke(
    "claude-sdk",
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
    reference,
    "hello"
  );
  assert.equal(
    provider.descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH),
    true
  );
  await registry.invoke(
    "claude-sdk",
    AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
    reference,
    "claude-model"
  );
  await registry.invoke(
    "claude-sdk",
    AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
    reference,
    "high"
  );
  await registry.invoke(
    "claude-sdk",
    AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
    reference,
    "Renamed"
  );
  assert.deepEqual(manager.calls, [
    ["send", "claude-native-a", "hello"],
    ["model", "claude-native-a", "claude-model"],
    ["reasoning", "claude-native-a", "high"],
    ["rename", "claude-native-a", "Renamed"]
  ]);
});

test("Codex bootstrap owns the concrete client behind a Provider runtime port", async () => {
  const calls = [];
  const runtime = new CodexProviderRuntime({
    client: {
      notifications: [{ method: "ready" }],
      archiveThread: async (...args) => calls.push(["archive", ...args]),
      deleteThread: async (...args) => calls.push(["delete", ...args]),
      unarchiveThread: async (...args) => calls.push(["unarchive", ...args])
    }
  });

  await runtime.archiveThread("thread-a");
  await runtime.deleteThread("thread-a");
  await runtime.unarchiveThread("thread-a");
  assert.deepEqual(runtime.notifications, [{ method: "ready" }]);
  assert.deepEqual(calls, [
    ["archive", "thread-a"],
    ["delete", "thread-a"],
    ["unarchive", "thread-a"]
  ]);
});

test("Provider bootstrap accepts external Provider factories without knowing their ids", async () => {
  const claude = createClaudeAgentSdkProvider(recordingManager());
  const registry = createAgentProviderRuntimeRegistry({
    claudeProvider: claude,
    codexOperations: recordingCodexOperations(),
    providerContext: { marker: "context-value" },
    additionalProviders: [
      (context) => ({
        descriptor: {
          id: "external.provider",
          displayName: context.marker,
          transport: "test",
          aliases: ["external"]
        },
        listSessions: () => [],
        readSession: (reference) => ({ id: reference.providerSessionId })
      })
    ]
  });

  assert.equal(registry.get("external").descriptor.displayName, "context-value");
  assert.deepEqual(registry.descriptors().map((descriptor) => descriptor.id), [
    "claude-sdk",
    "codex-app-server",
    "external.provider"
  ]);
  assert.equal(
    registry.get("codex-app-server").descriptor.capabilities.includes(
      AGENT_PROVIDER_CAPABILITIES.SESSION_BINDING_PROBE
    ),
    true
  );
});

test("Codex runtime bootstrap keeps a failed Session sendable for binding recovery", () => {
  const registry = createAgentProviderRuntimeRegistry({
    claudeProvider: createClaudeAgentSdkProvider(recordingManager()),
    codexOperations: recordingCodexOperations()
  });
  const session = registry.decorateSession("codex-app-server", {
    id: "session:capacity",
    status: "failed",
    sendUnavailableReason: "Selected model is at capacity. Please try a different model.",
    capabilities: { canSend: false }
  });

  assert.equal(
    registry.get("codex-app-server").descriptor.capabilities.includes(
      AGENT_PROVIDER_CAPABILITIES.SESSION_FAILED_BINDING_RECOVERY
    ),
    true
  );
  assert.deepEqual(session.actions.send, {
    available: true,
    reason: null,
    retryable: false
  });
});

test("Codex runtime bootstrap advertises durable Session recovery stabilization", async () => {
  const operations = recordingCodexOperations();
  const registry = createAgentProviderRuntimeRegistry({
    claudeProvider: createClaudeAgentSdkProvider(recordingManager()),
    codexOperations: operations
  });
  const provider = registry.get("codex-app-server");

  assert.equal(
    provider.descriptor.capabilities.includes(
      AGENT_PROVIDER_CAPABILITIES.SESSION_RECOVERY_STABILIZE
    ),
    true
  );
  assert.deepEqual(
    await registry.invoke(
      "codex-app-server",
      AGENT_PROVIDER_CAPABILITIES.SESSION_RECOVERY_STABILIZE,
      { providerSessionId: "thread:recovery" },
      { expectedMarker: "CORPTIE_RECOVERY_STABILIZED" }
    ),
    { durable: true }
  );
});

function recordingCodexOperations() {
  return {
    listSessions: () => [],
    readSession: (reference) => ({ id: reference.providerSessionId }),
    createSession: () => ({}),
    resumeSession: () => ({}),
    stabilizeRecoverySession: () => ({ durable: true }),
    prepareExecution: () => ({}),
    probeBinding: () => ({ ready: true }),
    deleteSession: () => true,
    restartSession: () => ({}),
    renameSession: () => ({}),
    send: () => ({}),
    clearConversation: () => ({}),
    interrupt: () => ({}),
    respondToApproval: () => ({}),
    listModels: () => ({ models: [] }),
    switchModel: () => ({}),
    switchReasoning: () => ({}),
    updatePermissions: () => ({}),
    prepareWorkspaceTransition: () => ({}),
    runBackgroundPrompt: () => ({}),
    readAccountUsage: () => ({}),
    readSessionUsage: () => ({}),
    attachTools: () => ({}),
    manageTurnChanges: () => ({})
  };
}
