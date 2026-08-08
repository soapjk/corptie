import assert from "node:assert/strict";
import test from "node:test";

import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES, AgentProviderCapabilityError } from "../src/agent-provider/contracts.mjs";
import { SessionWorkspaceCoordinator } from "../src/application/sessionWorkspaceCoordinator.mjs";

function provider(id, supportsTransition, calls) {
  const capabilities = supportsTransition ? [AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION] : [];
  return new CallbackAgentProvider({ id, displayName: id, transport: "fake", capabilities }, {
    listSessions: () => [],
    readSession: () => null,
    prepareWorkspaceTransition: supportsTransition
      ? async (reference, input) => {
          calls.push([reference, input]);
          return { status: "completed" };
        }
      : undefined
  });
}

test("Workspace Coordinator invokes a declared Provider port without inspecting Provider names", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry([provider("fake", true, calls)]);
  const coordinator = new SessionWorkspaceCoordinator({
    registry,
    resolveSessionReference: () => ({
      sessionId: "legacy",
      logicalSessionId: "logical",
      providerId: "fake",
      providerSessionId: "native"
    })
  });
  const result = await coordinator.switchWorkspace("logical", { targetWorkspaceId: "workspace:next" });
  assert.equal(result.status, "completed");
  assert.equal(calls[0][1].targetWorkspaceId, "workspace:next");
});

test("Workspace Coordinator exposes an explicit capability error for unsupported Providers", async () => {
  const registry = new AgentProviderRegistry([provider("limited", false, [])]);
  const coordinator = new SessionWorkspaceCoordinator({
    registry,
    resolveSessionReference: () => ({
      sessionId: "limited-session",
      providerId: "limited",
      providerSessionId: "native"
    })
  });
  await assert.rejects(
    () => coordinator.switchWorkspace("limited-session", { targetWorkspaceId: "workspace:next" }),
    (error) => error instanceof AgentProviderCapabilityError && error.code === "CAPABILITY_UNSUPPORTED"
  );
});
