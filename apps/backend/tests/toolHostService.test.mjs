import assert from "node:assert/strict";
import test from "node:test";

import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { ToolHostService } from "../src/application/toolHostService.mjs";
import { codexToolHostAttachment } from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import {
  claudeToolHostAttachment,
  createClaudeAgentSdkProvider
} from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { memoryDynamicTools } from "../src/application/memoryDynamicTools.mjs";

function provider(id, capabilities, operations = {}) {
  return new CallbackAgentProvider({ id, displayName: id, transport: "fake", capabilities }, {
    listSessions: () => [],
    readSession: () => null,
    ...operations
  });
}

test("Tool Host attaches one product-owned catalog through a Provider capability", async () => {
  const calls = [];
  const catalog = new HostToolCatalog([{
    id: "workspace",
    tools: [{ name: "corptie_list_workspaces", inputSchema: { type: "object" } }],
    execute: (input) => ({ actorId: input.actorId })
  }]);
  const registry = new AgentProviderRegistry([
    provider("hosted", [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH], {
      attachTools(attachment) {
        calls.push(attachment);
        return { nativeTools: attachment.tools, identity: attachment.actorId };
      }
    })
  ]);
  const service = new ToolHostService({ registry, catalog });
  const prepared = await service.prepareSession("hosted", { actorId: "agent-one" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools[0].name, "corptie_list_workspaces");
  assert.equal(prepared.actorId, "agent-one");
  assert.equal(prepared.providerAttachment.identity, "agent-one");
});

test("Tool Host carries immutable Session scope metadata into authorization and Provider attachment", async () => {
  const calls = [];
  const catalog = new HostToolCatalog([{
    id: "objective-chat",
    tools: [{ name: "corptie_objective_context" }],
    authorize: ({ metadata }) => metadata?.sessionKind === "objectiveChat" && metadata?.objectiveId === "objective:1",
    execute: () => ({})
  }]);
  const registry = new AgentProviderRegistry([provider("hosted", [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH], {
    attachTools(attachment) { calls.push(attachment); return attachment; }
  })]);
  const service = new ToolHostService({ registry, catalog });
  const prepared = await service.prepareSession("hosted", {
    actorId: "assistant", sessionKind: "objectiveChat", objectiveId: "objective:1"
  });
  assert.equal(prepared.providerAttachment.tools[0].name, "corptie_objective_context");
  assert.equal(calls[0].metadata.objectiveId, "objective:1");
  assert.ok(Object.isFrozen(calls[0].metadata));
});

test("Tool Host does not attach tools when a Provider does not declare support", async () => {
  const registry = new AgentProviderRegistry([provider("plain", [])]);
  const service = new ToolHostService({ registry, catalog: new HostToolCatalog() });
  assert.equal(await service.prepareSession("plain"), null);
});

test("Host Tool Catalog dispatches by tool name without Provider knowledge", async () => {
  const catalog = new HostToolCatalog([{
    id: "collaboration",
    tools: [{ name: "corptie_agents_discover" }],
    execute: (input) => ({ actorId: input.actorId, arguments: input.arguments })
  }]);
  assert.deepEqual(await catalog.execute({
    actorId: "agent-one",
    tool: "corptie_agents_discover",
    arguments: { status: "available" }
  }), {
    actorId: "agent-one",
    arguments: { status: "available" }
  });
  await assert.rejects(
    () => catalog.execute({ tool: "unknown" }),
    (error) => error.code === "HOST_TOOL_UNSUPPORTED"
  );
});

test("Host Tool Catalog hides and rejects actor-restricted tools at both authorization layers", async () => {
  const catalog = new HostToolCatalog([{
    id: "platform",
    tools: [{ name: "corptie_platform_agents_list" }],
    authorize: ({ actorId }) => actorId === "assistant",
    execute: () => ({ ok: true })
  }]);

  assert.deepEqual(catalog.definitions({ actorId: "ordinary-agent" }), []);
  assert.deepEqual(catalog.definitions({ actorId: "assistant" }).map((tool) => tool.name), [
    "corptie_platform_agents_list"
  ]);
  await assert.rejects(
    () => catalog.execute({ actorId: "ordinary-agent", tool: "corptie_platform_agents_list" }),
    (error) => error.code === "AGENT_TOOL_FORBIDDEN"
  );
  assert.deepEqual(
    await catalog.execute({ actorId: "assistant", tool: "corptie_platform_agents_list" }),
    { ok: true }
  );
});

test("Codex Provider maps the common attachment to its native dynamic-tool options", () => {
  const mapped = codexToolHostAttachment({
    actorId: "agent-one",
    tools: [{ name: "corptie_agents_discover" }]
  }, { developerInstructions: "Provider runtime instructions" });

  assert.equal(mapped.dynamicToolAgentId, "agent-one");
  assert.equal(mapped.dynamicTools[0].name, "corptie_agents_discover");
  assert.equal(mapped.developerInstructions, "Provider runtime instructions");
});

test("Claude Provider maps the common attachment to MCP, skills, and project settings", () => {
  const provider = createClaudeAgentSdkProvider({}, { attachTools: () => ({}) });
  assert.ok(provider.descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH));

  const mapped = claudeToolHostAttachment({
    actorId: "agent-claude",
    tools: [{ name: "corptie_agents_discover" }]
  }, {
    mcpServers: { corptie: { type: "stdio", command: "node" } },
    plugins: [{ type: "local", path: "/runtime/corptie-plugin", skipMcpDiscovery: true }],
    systemPrompt: { type: "preset", preset: "claude_code", append: "Stable Agent identity: agent-claude" }
  });

  assert.equal(mapped.actorId, "agent-claude");
  assert.equal(mapped.mcpServers.corptie.command, "node");
  assert.equal(mapped.plugins[0].path, "/runtime/corptie-plugin");
  assert.equal(mapped.skills, "all");
  assert.deepEqual(mapped.settingSources, ["user", "project", "local"]);
  assert.deepEqual(mapped.disallowedTools, ["EnterWorktree", "ExitWorktree"]);
  assert.match(mapped.systemPrompt.append, /agent-claude/);
});

test("Claude Provider preserves extra native tool restrictions while reserving Worktree routing for Corptie", () => {
  const mapped = claudeToolHostAttachment({
    actorId: "agent-claude",
    tools: [{ name: "corptie_create_worktree" }]
  }, {
    disallowedTools: ["WebSearch", "EnterWorktree"]
  });

  assert.deepEqual(mapped.disallowedTools, ["EnterWorktree", "ExitWorktree", "WebSearch"]);
});

test("Codex and Claude Provider sessions receive the same provider-neutral memory tool contract", async () => {
  const attachments = new Map();
  const providers = ["codex-contract", "claude-contract"].map((id) => provider(
    id,
    [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH],
    {
      attachTools(attachment) {
        attachments.set(id, attachment);
        return { attached: true };
      }
    }
  ));
  const service = new ToolHostService({
    registry: new AgentProviderRegistry(providers),
    catalog: new HostToolCatalog([{
      id: "memory",
      tools: memoryDynamicTools,
      execute: () => ({})
    }])
  });
  await service.prepareSession("codex-contract", { actorId: "agent:1", sessionId: "session:1" });
  await service.prepareSession("claude-contract", { actorId: "agent:1", sessionId: "session:1" });
  const expected = [
    "corptie_memory_search",
    "corptie_memory_list",
    "corptie_memory_remember",
    "corptie_memory_update",
    "corptie_memory_revoke"
  ];
  assert.deepEqual(attachments.get("codex-contract").tools.map((tool) => tool.name), expected);
  assert.deepEqual(attachments.get("claude-contract").tools.map((tool) => tool.name), expected);
  assert.deepEqual(
    attachments.get("claude-contract").tools.map((tool) => tool.inputSchema),
    attachments.get("codex-contract").tools.map((tool) => tool.inputSchema)
  );
});

test("Session creation passes a prepared Tool Host attachment without knowing Provider mechanics", async () => {
  const calls = [];
  const capabilities = [
    AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
    AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
  ];
  const registry = new AgentProviderRegistry([provider("hosted", capabilities, {
    attachTools(attachment) {
      return { nativeIdentity: attachment.actorId };
    },
    createSession(input) {
      calls.push(input);
      return { id: "native-session", title: "Created" };
    }
  })]);
  const toolHostService = new ToolHostService({
    registry,
    catalog: new HostToolCatalog([{
      id: "workspace",
      tools: [{ name: "corptie_list_workspaces" }],
      execute: () => ({})
    }])
  });
  const sessions = new SessionApplicationService({
    registry,
    toolHostService,
    resolveSessionReference: () => null
  });

  await sessions.createSession("hosted", { cwd: "/repo" }, { actorId: "agent-one" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolHost.actorId, "agent-one");
  assert.equal(calls[0].toolHost.providerAttachment.nativeIdentity, "agent-one");
});

test("Session creation requires an existing Agent actorId (no silent actor generation)", async () => {
  const registry = new AgentProviderRegistry([provider("hosted", [
    AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
    AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
  ], {
    attachTools: (attachment) => ({ nativeIdentity: attachment.actorId }),
    createSession: () => ({ id: "native-session", title: "Created" })
  })]);
  const toolHostService = new ToolHostService({
    registry,
    catalog: new HostToolCatalog([{ id: "workspace", tools: [{ name: "corptie_list_workspaces" }], execute: () => ({}) }])
  });
  const sessions = new SessionApplicationService({
    registry,
    toolHostService,
    resolveSessionReference: () => null
  });

  await assert.rejects(
    () => sessions.createSession("hosted", { cwd: "/repo" }),
    (error) => error.code === "AGENT_REQUIRED"
  );
});
