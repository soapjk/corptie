import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import {
  CODEX_TOOL_SCHEMA_CAPABILITIES,
  createCodexAppServerProvider
} from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import {
  CLAUDE_TOOL_SCHEMA_CAPABILITIES,
  createClaudeAgentSdkProvider
} from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import {
  createOpenClackyProvider,
  openClackyToolSchemaCapabilities
} from "../src/agent-provider/providers/openClackyProvider.mjs";
import { providerToolSchemaCapabilities } from "../src/agent-provider/toolSchemaCapabilities.mjs";

const noopManager = new Proxy({}, { get: () => () => null });

test("Codex reports create attach but never claims thread/resume dynamic append", async () => {
  const provider = createCodexAppServerProvider({ createSession: () => null });
  const capabilities = await providerToolSchemaCapabilities(provider);
  assert.deepEqual(capabilities, CODEX_TOOL_SCHEMA_CAPABILITIES);
  assert.equal(capabilities.bootstrapAttach, true);
  assert.equal(capabilities.appendInPlace, false);
  assert.equal(capabilities.replaceAtTurnBoundary, false);
  assert.equal(capabilities.restrictedGateway, true);
  assert.equal(capabilities.bindingReplacement, true);
  assert.equal(
    provider.descriptor.capabilities.includes(
      AGENT_PROVIDER_CAPABILITIES.SESSION_FAILED_BINDING_RECOVERY
    ),
    true
  );
});

test("Claude exposes only catalog-backed authenticated MCP refresh", async () => {
  const provider = createClaudeAgentSdkProvider(noopManager);
  const capabilities = await providerToolSchemaCapabilities(provider);
  assert.deepEqual(capabilities, CLAUDE_TOOL_SCHEMA_CAPABILITIES);
  assert.equal(capabilities.appendInPlace, false);
  assert.equal(capabilities.generatedMcpRefresh, true);
  assert.equal(capabilities.bindingReplacement, false);
});

test("OpenClacky capability result follows bridge facts instead of Provider name", async () => {
  const manager = {
    ...noopManager,
    probe: { protocolVersion: "v2", capabilities: { toolHost: true, toolHostReplace: true } }
  };
  const expected = openClackyToolSchemaCapabilities(manager);
  const provider = createOpenClackyProvider(manager, { attachTools: () => null });
  const capabilities = await providerToolSchemaCapabilities(provider);
  assert.deepEqual(capabilities, expected);
  assert.equal(capabilities.replaceAtTurnBoundary, true);
  assert.equal(capabilities.restrictedGateway, true);
});

test("unprobed OpenClacky does not make a false online-refresh claim", () => {
  const capabilities = openClackyToolSchemaCapabilities({ probe: null });
  assert.equal(capabilities.bootstrapAttach, false);
  assert.equal(capabilities.replaceAtTurnBoundary, false);
  assert.equal(capabilities.restrictedGateway, false);
  assert.equal(capabilities.bindingReplacement, false);
});
