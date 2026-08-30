import assert from "node:assert/strict";
import test from "node:test";

import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import {
  ProviderWorkspaceBindingService,
  persistedProviderWorkspaceProof
} from "../src/agent-provider/providerWorkspaceBindingService.mjs";
import { startupContextHash } from "../src/application/workSessionStartupCoordinator.mjs";
import { createCodexAppServerProvider } from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { createOpenClackyProvider } from "../src/agent-provider/providers/openClackyProvider.mjs";

const binding = Object.freeze({
  logicalSessionId: "session:one",
  providerBindingId: "startup-binding:one",
  bindingGeneration: 1,
  workingDirectory: "/Volumes/T9/worktrees/one",
  trustedContextHash: "c".repeat(64),
  idempotencyKey: "bind:one"
});

function operations(providerResourceId) {
  const makeProof = (input) => ({
    providerBindingId: input.providerBindingId,
    bindingGeneration: input.bindingGeneration,
    providerResourceId,
    canonicalWorkingDirectory: input.workingDirectory,
    trustedContextHash: input.trustedContextHash,
    acceptedAt: "2026-08-30T00:00:00.000Z"
  });
  return { bindWorkspace: makeProof, inspectWorkspaceBinding: makeProof };
}

test("Codex, Claude, and OpenClacky advertise and implement one workspace.bind contract", async () => {
  const codexOps = operations("codex:resource");
  const claudeOps = operations("claude:resource");
  const openOps = operations("openclacky:resource");
  const codex = createCodexAppServerProvider({ ...codexOps, createSession() {} }, {
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE, AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND]
  });
  const claude = createClaudeAgentSdkProvider({}, claudeOps);
  const openclacky = createOpenClackyProvider({}, openOps);
  const registry = new AgentProviderRegistry([codex, claude, openclacky]);
  const service = new ProviderWorkspaceBindingService({ registry });

  for (const provider of registry.descriptors()) {
    assert.equal(provider.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND), true);
    const proof = await service.bindWorkspace({ ...binding, providerId: provider.id });
    const inspected = await service.inspectBinding({ ...binding, providerId: provider.id });
    assert.equal(proof.providerBindingId, binding.providerBindingId);
    assert.equal(proof.bindingGeneration, binding.bindingGeneration);
    assert.equal(proof.canonicalWorkingDirectory, binding.workingDirectory);
    assert.equal(inspected.trustedContextHash, binding.trustedContextHash);
  }
});

test("a Provider without workspace.bind fails explicitly instead of falling back to model Git discovery", async () => {
  const provider = createCodexAppServerProvider({ createSession() {} }, {
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE]
  });
  const service = new ProviderWorkspaceBindingService({ registry: new AgentProviderRegistry([provider]) });
  await assert.rejects(
    async () => service.bindWorkspace({ ...binding, providerId: provider.descriptor.id }),
    { code: "START_PROVIDER_BIND_UNSUPPORTED" }
  );
});

test("persisted Provider adapter proof validates Store identity and trusted-context bytes", () => {
  const trustedContext = {
    schemaVersion: 2,
    startupOperationId: "startup:one",
    logicalSessionId: "session:one",
    providerBindingId: "startup-binding:one",
    bindingGeneration: 1
  };
  const trustedContextHash = startupContextHash(trustedContext);
  const store = {
    getLogicalSession: () => ({
      logicalSessionId: "session:one",
      activeBinding: {
        providerId: "codex-app-server",
        providerSessionId: "codex:resource",
        boundCwd: "/Volumes/T9/worktrees/one"
      }
    }),
    selectOne: () => ({
      logical_session_id: "session:one",
      binding_generation: 1,
      provider_id: "codex-app-server",
      canonical_worktree_path: "/Volumes/T9/worktrees/one",
      provider_context_hash: trustedContextHash
    })
  };
  const input = { ...binding, providerId: "codex-app-server", trustedContext, trustedContextHash };
  const proof = persistedProviderWorkspaceProof(store, input);
  assert.equal(proof.trustedContextHash, trustedContextHash);
  assert.throws(
    () => persistedProviderWorkspaceProof(store, { ...input, trustedContext: { ...trustedContext, bindingGeneration: 2 } }),
    { code: "START_PROVIDER_CONTEXT_MISMATCH" }
  );
});
