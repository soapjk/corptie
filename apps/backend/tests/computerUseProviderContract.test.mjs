import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { createCodexAppServerProvider } from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { createOpenClackyProvider } from "../src/agent-provider/providers/openClackyProvider.mjs";
import { computerUseAvailability } from "../src/application/computerUseRuntime.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

function providers() {
  return [
    createCodexAppServerProvider({}, { capabilities: [] }),
    createClaudeAgentSdkProvider({}, { attachTools: () => ({}) }),
    createOpenClackyProvider({ probe: { capabilities: { toolHost: true } } }, { attachTools: () => ({}) })
  ];
}

test("all supported Provider descriptors expose an explicit Computer Use compatibility declaration", () => {
  const registry = new AgentProviderRegistry(providers());
  const declarations = ["codex-app-server", "claude-sdk", "openclacky"].map(id => {
    const declaration = registry.get(id).descriptor.metadata.computerUse;
    assert.equal(typeof declaration.supported, "boolean");
    assert.equal(declaration.experimental, true);
    assert.equal(typeof declaration.reason, "string");
    return declaration;
  });
  assert.equal(declarations[0].supported, true);
  assert.equal(declarations[1].supported, true);
  assert.equal(declarations[2].supported, false);
  assert.ok(declarations[2].reason);

});

test("ordinary Tool Host support does not claim Computer Use compatibility on unverified Providers", () => {
  const registry = new AgentProviderRegistry(providers());
  for (const id of ["openclacky"]) {
    assert.equal(registry.supports(id, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH), true);
    const supported = registry.get(id).descriptor.metadata.computerUse.supported;
    assert.equal(computerUseAvailability({ status: "dependencies_available" }, {
      enabled: true, supported,
      permissions: { accessibility: true, screenRecording: true },
      protocol: { nativeConnection: true, appApprovals: true, images: true, cancellation: true, context: true }
    }).errorCode, "COMPUTER_USE_PROVIDER_UNSUPPORTED");
  }
});

test("native image Providers use the shared MCP route without native model Turn binding", () => {
  for (const provider of providers().slice(0, 2)) {
    assert.equal(provider.descriptor.metadata.computerUse.supported, true);
    assert.equal(provider.descriptor.metadata.computerUse.transport, "session-mcp");
    assert.equal(computerUseAvailability({ status: "dependencies_available" }, {
      enabled: true, supported: true }).status, "protocol_unverified");
  }
});

test("Codex call correlation comes from native invocation fields, never model arguments", async () => {
  const calls = [];
  const client = new CodexAppServerClient({ onDynamicToolCall: async input => { calls.push(input); return { ok: true }; } });
  client.dynamicToolAgentsByThread.set("native-thread", "bound-role");
  client.dynamicToolMetadataByThread.set("native-thread", { logicalSessionId: "logical:session", providerBindingId: "binding:current" });
  client.respondToServerRequest = async () => {};
  await client.handleDynamicToolCall({ id: 1, params: {
    threadId: "native-thread", turnId: "native-turn", callId: "native-call", tool: "corptie_tool_call",
    arguments: { threadId: "spoof-thread", turnId: "spoof-turn", callId: "spoof-call",
      _meta: { "x-codex-turn-metadata": { thread_id: "spoof-thread", turn_id: "spoof-turn", call_id: "spoof-call" } } }
  } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].providerRequestMeta, {
    "x-codex-turn-metadata": { thread_id: "native-thread", turn_id: "native-turn", call_id: "native-call" }
  });
  assert.equal(calls[0].metadata.providerBindingId, "binding:current");
});
