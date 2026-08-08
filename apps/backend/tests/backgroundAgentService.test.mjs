import assert from "node:assert/strict";
import test from "node:test";

import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { BackgroundAgentService, BackgroundAgentUnavailableError } from "../src/application/backgroundAgentService.mjs";

function provider(id, capabilities, calls) {
  return new CallbackAgentProvider({ id, displayName: id, transport: "fake", capabilities }, {
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
