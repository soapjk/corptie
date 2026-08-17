import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { createAgentProviderRuntimeRegistry } from "../src/agent-provider/bootstrap/agentProviderBootstrap.mjs";
import { CodexProviderRuntime } from "../src/agent-provider/bootstrap/codexProviderRuntime.mjs";

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
    updateAvatar: (id, avatarPath) => calls.push(["avatar", id, avatarPath]),
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
  await registry.invoke(
    "claude-sdk",
    AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
    reference,
    "claude-model"
  );
  await registry.invoke(
    "claude-sdk",
    AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
    reference,
    "Renamed"
  );
  await registry.invoke(
    "claude-sdk",
    AGENT_PROVIDER_CAPABILITIES.SESSION_AVATAR_UPDATE,
    reference,
    "/tmp/avatar.png"
  );
  assert.deepEqual(manager.calls, [
    ["send", "claude-native-a", "hello"],
    ["model", "claude-native-a", "claude-model"],
    ["rename", "claude-native-a", "Renamed"],
    ["avatar", "claude-native-a", "/tmp/avatar.png"]
  ]);
});

test("Codex bootstrap owns the concrete client behind a Provider runtime port", async () => {
  const calls = [];
  const runtime = new CodexProviderRuntime({
    client: {
      notifications: [{ method: "ready" }],
      readThread: async (...args) => calls.push(["read", ...args]),
      deleteThread: async (...args) => calls.push(["delete", ...args])
    }
  });

  await runtime.readThread("thread-a", { includeTurns: true });
  await runtime.deleteThread("thread-a");
  assert.deepEqual(runtime.notifications, [{ method: "ready" }]);
  assert.deepEqual(calls, [
    ["read", "thread-a", { includeTurns: true }],
    ["delete", "thread-a"]
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
});

function recordingCodexOperations() {
  return {
    listSessions: () => [],
    readSession: (reference) => ({ id: reference.providerSessionId }),
    createSession: () => ({}),
    resumeSession: () => ({}),
    deleteSession: () => true,
    restartSession: () => ({}),
    renameSession: () => ({}),
    updateAvatar: () => ({}),
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
