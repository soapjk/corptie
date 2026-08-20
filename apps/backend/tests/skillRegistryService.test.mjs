import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SkillRegistryService } from "../src/application/skillRegistryService.mjs";
import { callSkillDynamicTool } from "../src/application/skillDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-skill-registry-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const source = join(directory, "source");
  const runtime = join(directory, "runtime-skills");
  await mkdir(join(source, "skills", "alpha"), { recursive: true });
  await mkdir(join(source, "skills", "investrace"), { recursive: true });
  await writeFile(join(source, "skills", "alpha", "SKILL.md"), [
    "---", "name: alpha", "description: Alpha workflow", "---", "Alpha instructions"
  ].join("\n"));
  await writeFile(join(source, "skills", "investrace", "SKILL.md"), [
    "---", "name: investrace", "description: Record investment decisions", "---", "Investrace instructions"
  ].join("\n"));
  const service = new SkillRegistryService({ store, skillsDirs: { test: runtime } });
  return { directory, source, runtime, store, service };
}

test("multi-Skill source requires an explicit candidate and materializes the selected Skill", async () => {
  const value = await fixture();
  try {
    const discovery = await value.service.discover({ sourceType: "local", source: value.source });
    assert.deepEqual(discovery.candidates.map((item) => item.manifestName), ["alpha", "investrace"]);

    await assert.rejects(
      value.service.register({ sourceType: "local", source: value.source }),
      (error) => error.code === "AMBIGUOUS_SKILL_SOURCE" && error.candidates.length === 2
    );

    const skill = await value.service.register({
      sourceType: "local",
      source: value.source,
      sourceSubpath: "skills/investrace"
    });
    assert.equal(skill.manifestName, "investrace");
    assert.equal(skill.sourceSubpath, "skills/investrace");
    const installed = await readFile(join(value.runtime, skill.skillId, "SKILL.md"), "utf8");
    assert.match(installed, /Investrace instructions/);
    assert.doesNotMatch(installed, /Alpha instructions/);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("plain Skill with only SKILL.md remains installable and loadable", async () => {
  const value = await fixture();
  try {
    const skill = await value.service.register({
      sourceType: "local",
      source: join(value.source, "skills", "alpha")
    });
    assert.equal(skill.manifestName, "alpha");
    const installed = await readFile(join(value.runtime, skill.skillId, "SKILL.md"), "utf8");
    assert.match(installed, /Alpha instructions/);

    const agent = value.store.createAgent({ name: "Plain", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    assert.deepEqual(await value.service.mcpServersForAgent(agent.agentId, "test"), {});
    assert.match((await value.service.loadForAgent(agent.agentId, skill.skillId)).content, /Alpha instructions/);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("compound Skill discovers, copies, and resolves MCP descriptor resources", async () => {
  const value = await fixture();
  try {
    const compound = join(value.directory, "compound");
    await mkdir(join(compound, "resources"), { recursive: true });
    await writeFile(join(compound, "SKILL.md"), [
      "---", "name: compound", "description: Compound workflow", "---", "Use the bundled MCP server."
    ].join("\n"));
    const mcpModule = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    const stdioModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    await writeFile(join(compound, "server.mjs"), [
      `import { McpServer } from ${JSON.stringify(mcpModule)};`,
      `import { StdioServerTransport } from ${JSON.stringify(stdioModule)};`,
      "const server = new McpServer({ name: 'compound-fixture', version: '1.0.0' });",
      "server.registerTool('compound_ping', { description: 'Verify the installed Skill MCP server.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'compound-pong' }] }));",
      "await server.connect(new StdioServerTransport());",
      ""
    ].join("\n"));
    await writeFile(join(compound, "resources", "schema.json"), "{\"type\":\"object\"}\n");
    await writeFile(join(compound, ".mcp.json"), `${JSON.stringify({
      mcpServers: {
        compound_tools: {
          type: "stdio",
          command: "node",
          args: ["${SKILL_ROOT}/server.mjs", "--schema", "./resources/schema.json"],
          env: { COMPOUND_ROOT: "${SKILL_ROOT}" }
        }
      },
      resources: ["resources/schema.json"]
    }, null, 2)}\n`);

    const discovery = await value.service.discover({ sourceType: "local", source: compound });
    assert.equal(discovery.candidates[0].composition.kind, "mcp");
    assert.deepEqual(discovery.candidates[0].composition.mcp.serverNames, ["compound_tools"]);
    assert.deepEqual(discovery.candidates[0].composition.mcp.resources, ["resources/schema.json", "server.mjs"]);

    const skill = await value.service.register({ sourceType: "local", source: compound });
    const installedRoot = join(value.runtime, skill.skillId);
    assert.match(await readFile(join(installedRoot, "SKILL.md"), "utf8"), /bundled MCP server/);
    assert.match(await readFile(join(installedRoot, ".mcp.json"), "utf8"), /compound_tools/);
    assert.match(await readFile(join(installedRoot, "server.mjs"), "utf8"), /compound_ping/);
    assert.match(await readFile(join(installedRoot, "resources", "schema.json"), "utf8"), /object/);

    const agent = value.store.createAgent({ name: "Compound", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    const servers = await value.service.mcpServersForAgent(agent.agentId, "test");
    assert.equal(servers.compound_tools.command, "node");
    assert.equal(servers.compound_tools.cwd, installedRoot);
    assert.equal(servers.compound_tools.args[0], join(installedRoot, "server.mjs"));
    assert.equal(servers.compound_tools.args[2], join(installedRoot, "resources", "schema.json"));
    assert.equal(servers.compound_tools.env.COMPOUND_ROOT, installedRoot);

    const client = new Client({ name: "compound-skill-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: servers.compound_tools.command,
      args: servers.compound_tools.args,
      cwd: servers.compound_tools.cwd,
      env: { ...process.env, ...servers.compound_tools.env }
    });
    try {
      await client.connect(transport);
      const called = await client.callTool({ name: "compound_ping", arguments: {} });
      assert.equal(called.content[0].text, "compound-pong");
    } finally {
      await client.close();
    }
    await assert.rejects(
      value.service.mcpServersForAgent(agent.agentId, "provider-without-skill-runtime"),
      (error) => error.code === "MCP_PROVIDER_UNSUPPORTED" && /compound/.test(error.message)
    );
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("plugin manifest binds nested Skills to a package-level MCP descriptor and resources", async () => {
  const value = await fixture();
  try {
    const plugin = join(value.directory, "plugins", "investrace");
    const skillRoot = join(plugin, "skills", "investrace");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(join(plugin, "scripts"), { recursive: true });
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await writeFile(join(plugin, ".codex-plugin", "plugin.json"), `${JSON.stringify({
      name: "investrace",
      skills: "./skills/",
      mcpServers: "./.mcp.json"
    }, null, 2)}\n`);
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: investrace\ndescription: Portfolio tools\n---\nUse native tools.\n");
    await writeFile(join(skillRoot, "references", "contract.md"), "tool contract\n");
    const mcpModule = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    const stdioModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    await writeFile(join(plugin, "scripts", "investrace-mcp.mjs"), [
      `import { McpServer } from ${JSON.stringify(mcpModule)};`,
      `import { StdioServerTransport } from ${JSON.stringify(stdioModule)};`,
      "const server = new McpServer({ name: 'investrace-fixture', version: '1.0.0' });",
      "for (let index = 0; index < 24; index += 1) {",
      "  const name = index === 0 ? 'investrace_context' : `investrace_tool_${index}`;",
      "  server.registerTool(name, { description: `Investrace fixture ${index}`, inputSchema: {} }, async () => ({ content: [{ type: 'text', text: name === 'investrace_context' ? JSON.stringify({ contextOk: true, positions: [] }) : name }] }));",
      "}",
      "await server.connect(new StdioServerTransport());",
      ""
    ].join("\n"));
    await writeFile(join(plugin, ".mcp.json"), `${JSON.stringify({
      mcpServers: {
        investrace: { command: "node", args: ["${PLUGIN_ROOT}/scripts/investrace-mcp.mjs"] }
      }
    }, null, 2)}\n`);

    const discovery = await value.service.discover({
      sourceType: "local",
      source: value.directory
    });
    const candidate = discovery.candidates.find((item) => item.manifestName === "investrace");
    assert.equal(candidate.packageRelativePath, "plugins/investrace");
    assert.equal(candidate.composition.package.discoveryMethod, "plugin-manifest");
    assert.equal(candidate.composition.package.skillPath, "skills/investrace");
    assert.deepEqual(candidate.composition.mcp.serverNames, ["investrace"]);
    assert.deepEqual(candidate.composition.mcp.resources, ["scripts/investrace-mcp.mjs"]);

    const skill = await value.service.register({
      sourceType: "local",
      source: value.directory,
      sourceSubpath: candidate.relativePath
    });
    assert.equal(skill.packageSubpath, "plugins/investrace");
    const installedRoot = join(value.runtime, skill.skillId);
    assert.match(await readFile(join(installedRoot, "SKILL.md"), "utf8"), /native tools/);
    assert.match(await readFile(join(installedRoot, ".mcp.json"), "utf8"), /investrace/);
    assert.match(await readFile(join(installedRoot, "scripts", "investrace-mcp.mjs"), "utf8"), /investrace_context/);

    const agent = value.store.createAgent({ name: "Investor", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    const servers = await value.service.mcpServersForAgent(agent.agentId, "test");
    assert.equal(servers.investrace.args[0], join(installedRoot, "scripts", "investrace-mcp.mjs"));
    const client = new Client({ name: "plugin-package-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: servers.investrace.command,
      args: servers.investrace.args,
      cwd: servers.investrace.cwd,
      env: { ...process.env, ...servers.investrace.env }
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 24);
      assert.ok(tools.tools.every((tool) => tool.name.startsWith("investrace_")));
      const context = await client.callTool({ name: "investrace_context", arguments: {} });
      assert.deepEqual(JSON.parse(context.content[0].text), { contextOk: true, positions: [] });
    } finally {
      await client.close();
    }
    const events = value.service.runtimeEvents({ skillId: skill.skillId, limit: 50 });
    assert.ok(events.some((event) => event.stage === "assignment" && event.status === "success"));
    assert.ok(events.some((event) => event.stage === "mcp-loading" && event.status === "success"));
    assert.ok(events.some((event) => event.stage === "materialization"
      && event.status === "success" && event.toolCount === 24));
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Provider-incompatible MCP schema keywords fail with an explicit diagnostic", async () => {
  const value = await fixture();
  try {
    const serverModule = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");
    const stdioModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    const typesModule = import.meta.resolve("@modelcontextprotocol/sdk/types.js");
    for (const sample of [
      {
        name: "ref",
        schema: {
          type: "object",
          properties: { payload: { $ref: "#/$defs/Payload" } },
          $defs: { Payload: { type: "string" } }
        },
        expected: /\$defs|\$ref/
      },
      {
        name: "union",
        schema: {
          type: "object",
          properties: { payload: { anyOf: [{ type: "string" }, { type: "number" }] } }
        },
        expected: /anyOf/
      }
    ]) {
      const root = join(value.directory, `unsupported-${sample.name}`);
      await mkdir(root);
      await writeFile(join(root, "SKILL.md"), `---\nname: unsupported-${sample.name}\n---\nSchema regression.\n`);
      await writeFile(join(root, "server.mjs"), [
        `import { Server } from ${JSON.stringify(serverModule)};`,
        `import { StdioServerTransport } from ${JSON.stringify(stdioModule)};`,
        `import { ListToolsRequestSchema } from ${JSON.stringify(typesModule)};`,
        "const server = new Server({ name: 'schema-regression', version: '1.0.0' }, { capabilities: { tools: {} } });",
        `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: ${JSON.stringify(`bad_${sample.name}`)}, description: 'bad schema', inputSchema: ${JSON.stringify(sample.schema)} }] }));`,
        "await server.connect(new StdioServerTransport());",
        ""
      ].join("\n"));
      await writeFile(join(root, ".mcp.json"), JSON.stringify({
        mcpServers: { schema_regression: { command: "node", args: ["./server.mjs"] } }
      }));
      await assert.rejects(
        value.service.register({ sourceType: "local", source: root }),
        (error) => error.code === "MCP_TOOL_SCHEMA_UNSUPPORTED" && sample.expected.test(error.message)
      );
    }
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Skill runtime diagnostics persist across Store reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-skill-events-"));
  const dbPath = join(directory, "corptie.sqlite");
  let store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    const skill = store.createRegistrySkill({
      name: "persisted",
      sourceType: "local",
      source: directory
    });
    const agent = store.createAgent({ name: "Persisted Agent", provider: "codex-app-server" });
    store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    store.recordSkillRuntimeEvent({
      stage: "session-recovery",
      status: "success",
      skillId: skill.skillId,
      agentId: agent.agentId,
      sessionId: "session:persisted",
      providerId: "codex-app-server",
      serverNames: ["investrace"],
      toolCount: 24,
      reason: "Recovered."
    });
    await store.close();
    store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await store.initialize();
    const events = store.listSkillRuntimeEvents({ sessionId: "session:persisted" });
    assert.equal(events.length, 1);
    assert.equal(events[0].toolCount, 24);
    assert.deepEqual(events[0].serverNames, ["investrace"]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("selecting a nested Skill folder recovers its parent package only through an owning plugin manifest", async () => {
  const value = await fixture();
  try {
    const plugin = join(value.directory, "nested-plugin");
    const skillRoot = join(plugin, "skills", "nested");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "nested",
      skills: "./skills/",
      mcpServers: "./.mcp.json"
    }));
    await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
      mcpServers: { nested: { url: "http://127.0.0.1:9876/mcp" } }
    }));
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: nested\n---\nNested.\n");

    const discovery = await value.service.discover({ sourceType: "local", source: skillRoot });
    assert.equal(discovery.candidates[0].packageRelativePath, "../..");
    assert.equal(discovery.candidates[0].composition.package.discoveryMethod, "plugin-manifest");
    const skill = await value.service.register({ sourceType: "local", source: skillRoot });
    assert.equal(skill.source, await realpath(plugin));
    assert.equal(skill.sourceSubpath, "skills/nested");
    assert.equal(skill.packageSubpath, "");
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("multiple Skills from one plugin share one MCP dependency without a false name conflict", async () => {
  const value = await fixture();
  try {
    const plugin = join(value.directory, "shared-plugin");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    for (const name of ["research", "execution"]) {
      await mkdir(join(plugin, "skills", name), { recursive: true });
      await writeFile(join(plugin, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n${name}\n`);
    }
    await writeFile(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "shared",
      skills: "./skills/",
      mcpServers: "./.mcp.json"
    }));
    await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
      mcpServers: { shared: { url: "http://127.0.0.1:8765/mcp" } }
    }));
    const research = await value.service.register({
      sourceType: "local",
      source: plugin,
      sourceSubpath: "skills/research"
    });
    const execution = await value.service.register({
      sourceType: "local",
      source: plugin,
      sourceSubpath: "skills/execution"
    });
    const agent = value.store.createAgent({ name: "Shared", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(agent.agentId, [research.skillId, execution.skillId]);
    assert.deepEqual(await value.service.mcpServersForAgent(agent.agentId, "test"), {
      shared: { url: "http://127.0.0.1:8765/mcp" }
    });
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Agent-assisted discovery proposes paths but deterministic validation remains authoritative", async () => {
  const value = await fixture();
  try {
    const unusual = join(value.directory, "unusual");
    await mkdir(join(unusual, "workflow"), { recursive: true });
    await mkdir(join(unusual, "runtime"), { recursive: true });
    await writeFile(join(unusual, "workflow", "SKILL.md"), "---\nname: assisted\n---\nAssisted.\n");
    await writeFile(join(unusual, "runtime", ".mcp.json"), JSON.stringify({
      mcpServers: { assisted: { url: "http://127.0.0.1:9999/mcp" } }
    }));
    const calls = [];
    value.service.setDiscoveryAssistant(async (input) => {
      calls.push(input);
      return {
        packageRoot: ".",
        mcpDescriptor: "runtime/.mcp.json",
        confidence: 0.86,
        evidence: ["The workflow documentation names the runtime descriptor."]
      };
    });
    const discovery = await value.service.discover({ sourceType: "local", source: unusual });
    assert.equal(calls.length, 1);
    assert.equal(discovery.candidates[0].composition.package.discoveryMethod, "agent-assisted");
    assert.equal(discovery.candidates[0].composition.package.assistance.confidence, 0.86);
    const skill = await value.service.register({ sourceType: "local", source: unusual });
    assert.equal(skill.mcpDescriptorSubpath, "runtime/.mcp.json");
    assert.equal(skill.packageDiscoveryMethod, "agent-assisted");
    const agent = value.store.createAgent({ name: "Assisted", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    assert.deepEqual(await value.service.mcpServersForAgent(agent.agentId, "test"), {
      assisted: { url: "http://127.0.0.1:9999/mcp" }
    });

    value.service.setDiscoveryAssistant(async () => ({
      packageRoot: ".",
      mcpDescriptor: "../outside.json"
    }));
    await assert.rejects(
      value.service.discover({ sourceType: "local", source: unusual }),
      (error) => error.code === "PACKAGE_RESOURCE_OUTSIDE_ROOT"
    );
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("stdio MCP verification rejects an empty tool catalog without leaving a partial installation", async () => {
  const value = await fixture();
  try {
    const empty = join(value.directory, "empty-tools");
    await mkdir(empty);
    await writeFile(join(empty, "SKILL.md"), "---\nname: empty-tools\n---\nNo tools.\n");
    const mcpModule = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    const stdioModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    await writeFile(join(empty, "server.mjs"), [
      `import { McpServer } from ${JSON.stringify(mcpModule)};`,
      `import { StdioServerTransport } from ${JSON.stringify(stdioModule)};`,
      "const server = new McpServer({ name: 'empty', version: '1.0.0' });",
      "await server.connect(new StdioServerTransport());",
      ""
    ].join("\n"));
    await writeFile(join(empty, ".mcp.json"), JSON.stringify({
      mcpServers: { empty: { command: "node", args: ["./server.mjs"] } }
    }));

    await assert.rejects(
      value.service.register({ sourceType: "local", source: empty }),
      (error) => error.code === "MCP_TOOLS_EMPTY" && /tools\/list|未暴露任何工具/.test(error.message)
    );
    assert.equal(value.store.listRegistrySkills().some((skill) => skill.name === "empty-tools"), false);
    assert.deepEqual((await readdir(value.runtime)).filter((name) => name.includes("tmp-")), []);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Skill installation reports invalid directories, missing markers, and incomplete MCP packages", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      value.service.discover({ sourceType: "local", source: join(value.directory, "missing") }),
      (error) => error.code === "SOURCE_MISSING" && /不存在/.test(error.message)
    );

    const noMarker = join(value.directory, "no-marker");
    await mkdir(noMarker);
    await assert.rejects(
      value.service.register({ sourceType: "local", source: noMarker }),
      (error) => error.code === "INVALID_SKILL" && /SKILL\.md/.test(error.message)
    );

    const incomplete = join(value.directory, "incomplete");
    await mkdir(incomplete);
    await writeFile(join(incomplete, "SKILL.md"), "---\nname: incomplete\n---\n");
    await writeFile(join(incomplete, ".mcp.json"), JSON.stringify({
      mcpServers: { broken: { type: "stdio", args: ["./missing-server.mjs"] } }
    }));
    await assert.rejects(
      value.service.register({ sourceType: "local", source: incomplete }),
      (error) => error.code === "MCP_CONFIG_INCOMPLETE" && /broken.*command/.test(error.message)
    );

    await writeFile(join(incomplete, ".mcp.json"), JSON.stringify({
      mcpServers: { broken: { command: "node", args: ["./missing-server.mjs"] } }
    }));
    await assert.rejects(
      value.service.register({ sourceType: "local", source: incomplete }),
      (error) => error.code === "MCP_RESOURCE_MISSING" && /missing-server\.mjs/.test(error.message)
    );
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Skill search and load are limited to the authenticated Agent's assignments", async () => {
  const value = await fixture();
  try {
    const skill = await value.service.register({
      sourceType: "local",
      source: value.source,
      sourceSubpath: "skills/investrace"
    });
    const assigned = value.store.createAgent({ name: "Investor", provider: "codex-app-server" });
    const unassigned = value.store.createAgent({ name: "Other", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(assigned.agentId, [skill.skillId]);

    const search = await callSkillDynamicTool(value.service, {
      actorId: assigned.agentId,
      tool: "corptie_skill_search",
      arguments: { intent: "你能不能使用investrace" }
    });
    assert.equal(search.found, true);
    assert.equal(search.candidates[0].skillId, skill.skillId);

    const loaded = await value.service.loadForAgent(assigned.agentId, skill.skillId);
    assert.equal(loaded.name, "investrace");
    assert.match(loaded.content, /Investrace instructions/);

    await assert.rejects(
      value.service.loadForAgent(unassigned.agentId, skill.skillId),
      (error) => error.code === "SKILL_NOT_ASSIGNED"
    );
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Agent Skill replacement validates before deleting the existing assignment", async () => {
  const value = await fixture();
  try {
    const skill = await value.service.register({
      sourceType: "local",
      source: value.source,
      sourceSubpath: "skills/investrace"
    });
    const agent = value.store.createAgent({ name: "Investor", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    assert.throws(
      () => value.store.setAgentRegistrySkills(agent.agentId, ["skill:missing"]),
      (error) => error.code === "SKILL_NOT_FOUND"
    );
    assert.deepEqual(value.store.listRegistrySkillIdsForAgent(agent.agentId), [skill.skillId]);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("legacy registration repair selects the unique manifest matching the registered name", async () => {
  const value = await fixture();
  try {
    const legacy = value.store.createRegistrySkill({
      name: "investrace",
      description: "",
      sourceType: "local",
      source: value.source
    });
    const result = await value.service.repairLegacyRegistrations();
    assert.equal(result.repaired.length, 1);
    const repaired = value.store.getRegistrySkill(legacy.skillId);
    assert.equal(repaired.sourceSubpath, "skills/investrace");
    assert.equal(repaired.manifestName, "investrace");
    const installed = await readFile(join(value.runtime, legacy.skillId, "SKILL.md"), "utf8");
    assert.match(installed, /Investrace instructions/);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
