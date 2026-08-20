import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const runtimeSecond = join(directory, "runtime-skills-second");
  const cacheRoot = join(directory, "skill-cache");
  await mkdir(join(source, "skills", "alpha"), { recursive: true });
  await mkdir(join(source, "skills", "investrace"), { recursive: true });
  await writeFile(join(source, "skills", "alpha", "SKILL.md"), [
    "---", "name: alpha", "description: Alpha workflow", "---", "Alpha instructions"
  ].join("\n"));
  await writeFile(join(source, "skills", "investrace", "SKILL.md"), [
    "---", "name: investrace", "description: Record investment decisions", "---", "Investrace instructions"
  ].join("\n"));
  const service = new SkillRegistryService({
    store,
    skillsDirs: { test: runtime, second: runtimeSecond },
    cacheRoot
  });
  return { directory, source, runtime, runtimeSecond, cacheRoot, store, service };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

test("global deletion cascades independent assignments, every runtime copy, and the Git cache", async () => {
  const value = await fixture();
  try {
    const gitCache = join(value.cacheRoot, "skill-fixture");
    await mkdir(gitCache, { recursive: true });
    await writeFile(join(gitCache, "SKILL.md"), "---\nname: global\ndescription: shared\n---\nGlobal skill\n");
    const skill = value.store.createRegistrySkill({
      name: "global",
      description: "shared",
      sourceType: "git",
      source: "https://example.invalid/global.git",
      cachePath: gitCache,
      manifestName: "global",
      manifestDescription: "shared"
    });
    await value.service.materialize(skill);
    const first = value.store.createAgent({ name: "First" });
    const second = value.store.createAgent({ name: "Second" });
    value.store.setAgentRegistrySkills(first.agentId, [skill.skillId]);
    value.store.setAgentRegistrySkills(second.agentId, [skill.skillId]);

    const impact = value.service.deletionImpact(skill.skillId);
    assert.equal(impact.affectedAgentCount, 2);
    assert.deepEqual(impact.affectedAgents.map((agent) => agent.name), ["First", "Second"]);

    const revisionBeforeDelete = value.store.stateRevision();
    const result = await value.service.remove(skill.skillId);
    assert.equal(result.ok, true);
    assert.equal(result.operation.status, "completed");
    assert.equal(value.store.getRegistrySkill(skill.skillId), null);
    assert.deepEqual(value.store.listRegistrySkillIdsForAgent(first.agentId), []);
    assert.deepEqual(value.store.listRegistrySkillIdsForAgent(second.agentId), []);
    assert.equal(await pathExists(join(value.runtime, skill.skillId)), false);
    assert.equal(await pathExists(join(value.runtimeSecond, skill.skillId)), false);
    assert.equal(await pathExists(gitCache), false);
    const deletionChanges = value.store.stateChangesAfter(revisionBeforeDelete);
    assert.ok(deletionChanges.some((change) => (
      change.entityType === "skill" && change.entityId === skill.skillId && change.operation === "delete"
    )));
    assert.deepEqual(
      deletionChanges.filter((change) => change.entityType === "agent").map((change) => change.entityId).sort(),
      [first.agentId, second.agentId].sort()
    );
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("partial runtime cleanup failure is audited, returns failure, and restores removed copies for retry", async () => {
  const value = await fixture();
  try {
    const skill = await value.service.register({
      sourceType: "local",
      source: join(value.source, "skills", "alpha")
    });
    const agent = value.store.createAgent({ name: "Assigned" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    const failing = new SkillRegistryService({
      store: value.store,
      skillsDirs: { test: value.runtime, second: value.runtimeSecond },
      cacheRoot: value.cacheRoot,
      removePath: async (path, options) => {
        if (path.startsWith(value.runtimeSecond)) {
          const error = new Error("simulated permission denial");
          error.code = "EACCES";
          throw error;
        }
        await rm(path, options);
      }
    });

    await assert.rejects(
      failing.remove(skill.skillId),
      (error) => error.code === "SKILL_CLEANUP_FAILED"
        && error.operation.status === "cleanup_failed"
        && error.operation.cleanup.some((entry) => entry.status === "failed")
    );
    assert.ok(value.store.getRegistrySkill(skill.skillId));
    assert.deepEqual(value.store.listRegistrySkillIdsForAgent(agent.agentId), [skill.skillId]);
    assert.equal(await pathExists(join(value.runtime, skill.skillId, "SKILL.md")), true);
    assert.equal(await pathExists(join(value.runtimeSecond, skill.skillId, "SKILL.md")), true);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("active assigned Sessions block deletion before any runtime cleanup", async () => {
  const value = await fixture();
  try {
    const skill = await value.service.register({
      sourceType: "local",
      source: join(value.source, "skills", "alpha")
    });
    const agent = value.store.createAgent({ name: "Active" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    const session = value.store.createSession({
      title: "Still running",
      agentId: agent.agentId,
      agentName: agent.name,
      status: "running"
    });

    const impact = value.service.deletionImpact(skill.skillId);
    assert.equal(impact.canDelete, false);
    assert.equal(impact.activeSessions[0].sessionId, session.id);
    await assert.rejects(
      value.service.remove(skill.skillId),
      (error) => error.code === "SKILL_HAS_ACTIVE_SESSIONS" && error.impact.activeSessionCount === 1
    );
    assert.ok(value.store.getRegistrySkill(skill.skillId));
    assert.equal(await pathExists(join(value.runtime, skill.skillId, "SKILL.md")), true);
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
