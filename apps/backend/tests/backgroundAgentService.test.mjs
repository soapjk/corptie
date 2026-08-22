import assert from "node:assert/strict";
import test from "node:test";

import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { BackgroundAgentService, BackgroundAgentUnavailableError } from "../src/application/backgroundAgentService.mjs";

function provider(id, capabilities, calls, metadata = {}) {
  return new CallbackAgentProvider({ id, displayName: id, transport: "fake", capabilities, metadata }, {
    listSessions: () => [],
    readSession: () => null,
    runBackgroundPrompt: capabilities.includes(AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT)
      ? async (input) => {
          calls.push([id, input]);
          return { text: "Commit project changes" };
        }
      : undefined
  });
}

test("background work selects a capable Provider and always hides its transcript", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry([
    provider("chat-only", [], calls),
    provider("background", [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT], calls)
  ]);
  const service = new BackgroundAgentService({ registry, defaultProviderId: "background" });
  const result = await service.run({
    purpose: "commit-message",
    cwd: "/repo/worktree",
    prompt: "Write a commit message",
    historyPolicy: "visible"
  });

  assert.equal(result.providerId, "background");
  assert.equal(result.historyPolicy, "hidden");
  assert.equal(calls[0][1].historyPolicy, "hidden");
});

test("background work reports a structured error when no Provider supports it", () => {
  const registry = new AgentProviderRegistry([provider("chat-only", [], [])]);
  const service = new BackgroundAgentService({ registry });
  assert.throws(
    () => service.selectProvider(),
    (error) => error instanceof BackgroundAgentUnavailableError
  );
});

test("workspace-write background work selects a Provider that explicitly supports that profile", async () => {
  const calls = [];
  const capability = [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT];
  const registry = new AgentProviderRegistry([
    provider("read-only", capability, calls, { backgroundPermissionProfiles: ["read-only"] }),
    provider("writer", capability, calls, { backgroundPermissionProfiles: ["read-only", "workspace-write"] })
  ]);
  const service = new BackgroundAgentService({ registry, defaultProviderId: "read-only" });
  const result = await service.run({
    purpose: "toolset-initialization",
    cwd: "/repo/.corptie",
    allowedRoots: ["/repo/.corptie"],
    permissionProfile: "workspace-write",
    developerInstructions: "Only edit the toolset.",
    prompt: "Configure the toolset."
  });

  assert.equal(result.providerId, "writer");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].permissionProfile, "workspace-write");
  assert.equal(calls[0][1].developerInstructions, "Only edit the toolset.");
  assert.equal(calls[0][1].historyPolicy, "hidden");
});

test("workspace-write background work fails when no Provider declares that profile", () => {
  const capability = [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT];
  const registry = new AgentProviderRegistry([
    provider("read-only", capability, [], { backgroundPermissionProfiles: ["read-only"] })
  ]);
  const service = new BackgroundAgentService({ registry, defaultProviderId: "read-only" });

  assert.throws(
    () => service.selectProvider(null, "workspace-write"),
    (error) => error instanceof BackgroundAgentUnavailableError
  );
});

test("uses the operation-selected Provider while Agent contributes context only", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry([
    provider("codex-app-server", [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT], calls)
  ]);
  const service = new BackgroundAgentService({
    registry,
    defaultProviderId: "codex-app-server",
    resolveProviderId: (value) => ({ codex: "codex-app-server", claude_code: "claude-sdk" }[value] ?? null),
    resolveAgentContext: async () => ({ agent: { provider: "ignored-agent-provider" }, instructions: "agent context" })
  });

  const result = await service.run({
    purpose: "assist-draft",
    cwd: "/tmp",
    prompt: "Write a description",
    agentId: "agent:1",
    preferredProviderId: "codex"
  });

  assert.equal(result.providerId, "codex-app-server");
  assert.equal(calls.length, 1);
});

test("falls back to background default without consulting Agent Provider metadata", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry([
    provider("codex-app-server", [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT], calls)
  ]);
  const service = new BackgroundAgentService({
    registry,
    defaultProviderId: "codex-app-server",
    resolveProviderId: (value) => ({ codex: "codex-app-server" }[value] ?? null),
    resolveAgentContext: async () => ({ agent: { provider: "deepseek" }, instructions: null })
  });

  const result = await service.run({
    purpose: "assist-draft",
    cwd: "/tmp",
    prompt: "Write a description",
    agentId: "agent:1"
  });

  assert.equal(result.providerId, "codex-app-server");
});

test("reports context, Provider, and total duration without exposing the transcript", async () => {
  const calls = [];
  const events = [];
  const registry = new AgentProviderRegistry([
    provider("codex-app-server", [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT], calls)
  ]);
  const service = new BackgroundAgentService({
    registry,
    defaultProviderId: "codex-app-server",
    resolveAgentContext: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { instructions: "context" };
    },
    onOperationEvent: (type, payload) => events.push({ type, payload })
  });

  const result = await service.run({
    purpose: "assist-form-draft",
    cwd: "/tmp",
    prompt: "Generate fields",
    agentId: "agent:1"
  });

  assert.deepEqual(events.map((event) => event.type), ["BackgroundAgentStarted", "BackgroundAgentCompleted"]);
  const completed = events[1].payload;
  assert.ok(completed.phases.agentContextMs >= 0);
  assert.ok(completed.phases.providerInvokeMs >= 0);
  assert.ok(completed.totalMs >= completed.phases.agentContextMs);
  assert.deepEqual(result.performance, {
    phases: completed.phases,
    totalMs: completed.totalMs
  });
  assert.equal(Object.hasOwn(completed, "text"), false);
});
