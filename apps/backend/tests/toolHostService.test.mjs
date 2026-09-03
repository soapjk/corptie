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
import { artifactDynamicTools, authorizeArtifactDynamicTool } from "../src/application/artifactDynamicTools.mjs";
import { platformDynamicTools } from "../src/application/platformDynamicTools.mjs";
import { taskAcceptanceDynamicTools } from "../src/application/taskAcceptanceDynamicTools.mjs";

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

test("prospective replacement bindings preserve the explicitly requested Tool domains", async () => {
  const attachments = [];
  const registry = new AgentProviderRegistry([
    provider("replacement", [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH], {
      attachTools(attachment) {
        attachments.push(attachment);
        return { attached: true };
      }
    })
  ]);
  const service = new ToolHostService({
    registry,
    coordinator: {},
    catalog: new HostToolCatalog([{
      id: "memory",
      tools: memoryDynamicTools,
      execute: () => ({})
    }])
  });

  const prepared = await service.prepareSession("replacement", {
    actorId: "agent:replacement",
    logicalSessionId: "logical:replacement",
    sessionKind: "legacy",
    desiredToolDomains: ["memory"]
  });

  assert.deepEqual(prepared.materialization.desiredDomains, ["memory"]);
  assert.equal(attachments.length, 1);
  assert.ok(Array.isArray(attachments[0].tools));
});

test("Codex, Claude, and OpenClacky receive the same provider-neutral Artifact contracts", async () => {
  const attachments = new Map();
  const providerIds = ["codex-app-server", "claude-sdk", "openclacky"];
  const registry = new AgentProviderRegistry(providerIds.map((id) => provider(
    id,
    [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH],
    { attachTools(attachment) { attachments.set(id, attachment); return { attached: true }; } }
  )));
  const service = new ToolHostService({
    registry,
    catalog: new HostToolCatalog([{
      id: "artifacts", tools: artifactDynamicTools,
      authorize: authorizeArtifactDynamicTool, execute: () => ({})
    }])
  });
  for (const id of providerIds) await service.prepareSession(id, {
    actorId: "agent:artifact", sessionId: "session:artifact",
    workId: "work:artifact", sessionKind: "worker"
  });
  const expected = artifactDynamicTools.map((tool) => tool.name);
  for (const id of providerIds) {
    assert.deepEqual(attachments.get(id).tools.map((tool) => tool.name), expected);
    assert.equal(attachments.get(id).tools.find((tool) => tool.name === "corptie_artifact_create")
      .inputSchema.properties.idempotency_key.maxLength, 200);
  }
});

test("Artifact Host Tool authorization exposes provider-neutral scoped management and defers exact permission checks to the service", async () => {
  const catalog = new HostToolCatalog([{
    id: "artifacts", tools: artifactDynamicTools,
    authorize: authorizeArtifactDynamicTool, execute: () => ({ ok: true })
  }]);
  const worker = {
    actorId: "agent:worker",
    metadata: {
      sessionKind: "worker", sessionId: "session:worker",
      workId: "work:one", taskId: "task:one"
    }
  };
  assert.deepEqual(catalog.definitions(worker).map((tool) => tool.name), artifactDynamicTools.map((tool) => tool.name));
  assert.deepEqual(await catalog.execute({
    ...worker, tool: "corptie_artifact_create", arguments: { title: "Evidence" }
  }), { ok: true });
  assert.deepEqual(catalog.definitions({
    actorId: "agent:manager",
    metadata: { sessionKind: "workChat", sessionId: "session:manager", workId: "work:one" }
  }).map((tool) => tool.name), artifactDynamicTools.map((tool) => tool.name));
});

test("Tool Host carries immutable Session scope metadata into authorization and Provider attachment", async () => {
  const calls = [];
  const catalog = new HostToolCatalog([{
    id: "work-chat",
    tools: [{ name: "corptie_work_context" }],
    authorize: ({ metadata }) => metadata?.sessionKind === "workChat" && metadata?.workId === "work:1",
    execute: () => ({})
  }]);
  const registry = new AgentProviderRegistry([provider("hosted", [
    AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
    AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES
  ], {
    attachTools(attachment) { calls.push(attachment); return attachment; }
  })]);
  const service = new ToolHostService({ registry, catalog });
  const prepared = await service.prepareSession("hosted", {
    actorId: "assistant", sessionKind: "workChat", workId: "work:1"
  });
  assert.equal(prepared.providerAttachment.tools[0].name, "corptie_work_context");
  assert.equal(calls[0].metadata.workId, "work:1");
  assert.ok(Object.isFrozen(calls[0].metadata));
});

test("Tool Host does not attach tools when a Provider does not declare support", async () => {
  const registry = new AgentProviderRegistry([provider("plain", [])]);
  const service = new ToolHostService({ registry, catalog: new HostToolCatalog() });
  assert.equal(await service.prepareSession("plain"), null);
});

test("Tool Host fails loudly when an unsupported Provider would drop assigned Skill MCP dependencies", async () => {
  const registry = new AgentProviderRegistry([provider("plain", [])]);
  const service = new ToolHostService({
    registry,
    catalog: new HostToolCatalog(),
    resolveMcpServers: async () => ({ compound: { type: "stdio", command: "node" } })
  });
  await assert.rejects(
    service.prepareSession("plain", { actorId: "agent-compound" }),
    (error) => error.code === "MCP_PROVIDER_UNSUPPORTED" && /plain/.test(error.message)
  );
});

test("Tool Host rejects a Provider that attaches host tools but does not advertise Skill MCP support", async () => {
  const events = [];
  const registry = new AgentProviderRegistry([provider("host-tools-only", [
    AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
  ], {
    attachTools: (attachment) => attachment
  })]);
  const service = new ToolHostService({
    registry,
    catalog: new HostToolCatalog(),
    resolveMcpServers: async () => ({ investrace: { command: "node", args: ["server.mjs"] } }),
    recordRuntimeEvent: (event) => events.push(event)
  });
  await assert.rejects(
    service.prepareSession("host-tools-only", { actorId: "agent:investor", sessionId: "session:1" }),
    (error) => error.code === "MCP_PROVIDER_UNSUPPORTED" && /host-tools-only/.test(error.message)
  );
  assert.equal(events[0].stage, "provider-materialization");
  assert.equal(events[0].status, "failed");
  assert.equal(events[0].errorCode, "MCP_PROVIDER_UNSUPPORTED");
});

test("Host Tool Catalog dispatches by tool name without Provider knowledge", async () => {
  const catalog = new HostToolCatalog([{
    id: "collaboration",
    tools: [{
      name: "corptie_agents_discover",
      inputSchema: {
        type: "object", properties: { status: { type: "string" } },
        additionalProperties: false
      }
    }],
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
    (error) => error.code === "SESSION_TOOL_FORBIDDEN"
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

test("Codex and Claude Provider adapters configure assigned Skill MCP dependencies", () => {
  const attachment = {
    actorId: "agent-compound",
    tools: [],
    mcpServers: {
      compound_tools: {
        type: "stdio",
        command: "node",
        args: ["/runtime/skills/compound/server.mjs"],
        cwd: "/runtime/skills/compound"
      }
    }
  };
  const codex = codexToolHostAttachment(attachment, {
    config: { mcp_servers: { corptie: { command: "corptie-mcp" } } }
  });
  assert.equal(codex.config.mcp_servers.compound_tools.command, "node");
  assert.equal(codex.config.mcp_servers.compound_tools.type, undefined);
  assert.equal(codex.config.mcp_servers.corptie.command, "corptie-mcp");

  const claude = claudeToolHostAttachment(attachment, {
    mcpServers: { corptie: { type: "stdio", command: "corptie-mcp" } }
  });
  assert.equal(claude.mcpServers.compound_tools.type, "stdio");
  assert.equal(claude.mcpServers.compound_tools.cwd, "/runtime/skills/compound");
  assert.equal(claude.mcpServers.corptie.command, "corptie-mcp");
});

test("Tool Host resolves Agent Skill MCP dependencies before Provider attachment", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry([provider("hosted", [
    AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
    AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES
  ], {
    attachTools(attachment) { calls.push(attachment); return attachment; }
  })]);
  const service = new ToolHostService({
    registry,
    catalog: new HostToolCatalog(),
    resolveMcpServers: async ({ actorId, providerId }) => ({
      assigned: { type: "stdio", command: "node", args: [`/${providerId}/${actorId}/server.mjs`] }
    })
  });
  const prepared = await service.prepareSession("hosted", { actorId: "agent-compound" });
  assert.equal(calls[0].mcpServers.assigned.command, "node");
  assert.equal(prepared.providerAttachment.mcpServers.assigned.args[0], "/hosted/agent-compound/server.mjs");
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

test("Codex, Claude, and OpenClacky Provider sessions receive the same provider-neutral memory tool contract", async () => {
  const attachments = new Map();
  const providers = ["codex-contract", "claude-contract", "openclacky-contract"].map((id) => provider(
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
  await service.prepareSession("openclacky-contract", { actorId: "agent:1", sessionId: "session:1" });
  const expected = [
    "corptie_memory_search",
    "corptie_memory_get",
    "corptie_memory_list",
    "corptie_memory_remember",
    "corptie_memory_update",
    "corptie_memory_revoke"
  ];
  assert.deepEqual(attachments.get("codex-contract").tools.map((tool) => tool.name), expected);
  assert.deepEqual(attachments.get("claude-contract").tools.map((tool) => tool.name), expected);
  assert.deepEqual(attachments.get("openclacky-contract").tools.map((tool) => tool.name), expected);
  assert.deepEqual(
    attachments.get("claude-contract").tools.map((tool) => tool.inputSchema),
    attachments.get("codex-contract").tools.map((tool) => tool.inputSchema)
  );
});

test("Codex, Claude, and OpenClacky Tool Host attachments receive one platform-admin contract", async () => {
  const attachments = new Map();
  const providers = ["codex-platform", "claude-platform", "openclacky-platform"].map((id) => provider(id, [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH], {
    attachTools(attachment) { attachments.set(id, attachment); return { attached: true }; }
  }));
  const service = new ToolHostService({
    registry: new AgentProviderRegistry(providers),
    catalog: new HostToolCatalog([{ id: "platform", tools: platformDynamicTools, authorize: ({ actorId }) => actorId === "assistant", execute: () => ({}) }])
  });
  for (const id of ["codex-platform", "claude-platform", "openclacky-platform"]) {
    await service.prepareSession(id, { actorId: "assistant", sessionId: "provider:assistant", sessionKind: "assistantChat" });
  }
  const expected = platformDynamicTools.map((tool) => tool.name);
  for (const id of ["codex-platform", "claude-platform", "openclacky-platform"]) assert.deepEqual(attachments.get(id).tools.map((tool) => tool.name), expected);
});

test("Codex, Claude, and OpenClacky receive one provider-neutral Task completion contract", async () => {
  const attachments = new Map();
  const ids = ["codex-completion", "claude-completion", "openclacky-completion"];
  const providers = ids.map((id) => provider(id, [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH], {
    attachTools(attachment) { attachments.set(id, attachment); return { attached: true }; }
  }));
  const service = new ToolHostService({
    registry: new AgentProviderRegistry(providers),
    catalog: new HostToolCatalog([{
      id: "task-acceptance", tools: taskAcceptanceDynamicTools, execute: () => ({})
    }])
  });
  for (const id of ids) {
    await service.prepareSession(id, {
      actorId: "agent:worker", sessionId: "provider-session:worker",
      logicalSessionId: "session:worker", sessionKind: "worker",
      workId: "work:one", taskId: "task:one"
    });
  }
  const expected = attachments.get(ids[0]).tools;
  assert.ok(expected.some((tool) => tool.name === "corptie_task_complete"));
  for (const id of ids.slice(1)) assert.deepEqual(attachments.get(id).tools, expected);
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
