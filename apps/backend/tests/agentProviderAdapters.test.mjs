import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { CODEX_PTY_PROVIDER_ID, createPtyAgentProvider } from "../src/agent-provider/providers/ptyAgentProvider.mjs";
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
    respondToCodexApproval: (id, input) => calls.push(["approval", id, input]),
    respondToPtyChoice: (id, input) => calls.push(["pty-choice", id, input]),
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

test("Codex PTY protocol differences remain inside its Provider adapter", async () => {
  const manager = recordingManager(CODEX_PTY_PROVIDER_ID);
  const provider = createPtyAgentProvider(manager, { providerId: CODEX_PTY_PROVIDER_ID });
  const registry = new AgentProviderRegistry([provider]);
  const reference = { providerSessionId: "pty-native-a" };
  await registry.invoke(
    CODEX_PTY_PROVIDER_ID,
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
    reference,
    { itemType: "approval", approved: true }
  );
  await registry.invoke(
    CODEX_PTY_PROVIDER_ID,
    AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
    reference,
    "high"
  );
  await registry.invoke(
    CODEX_PTY_PROVIDER_ID,
    AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT,
    reference
  );
  assert.deepEqual(manager.calls, [
    ["approval", "pty-native-a", { itemType: "approval", approved: true }],
    ["reasoning", "pty-native-a", "high"],
    ["disconnect", "pty-native-a"]
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
