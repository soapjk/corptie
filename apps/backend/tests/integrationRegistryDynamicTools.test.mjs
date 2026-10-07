import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createHostToolCatalog as composeCatalog } from "../src/application/hostToolCatalogComposition.mjs";
import { searchableDomainText } from "../src/application/toolDiscoveryContracts.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { McpRegistryService } from "../src/application/mcpRegistryService.mjs";
import { SkillRegistryService } from "../src/application/skillRegistryService.mjs";
import { ToolHostMaterializationCoordinator } from "../src/application/toolHostMaterializationCoordinator.mjs";

const scope = { actorId: "agent:test", metadata: { sessionId: "session:test" } };
const createHostToolCatalog = (options) => composeCatalog({ getProjectCodeApplicationService: () => null,
  validateProjectCodeHostRoute: () => {}, ...options });
test("registration domain is discoverable for MCP and Skill and shared across Providers", async () => {
  const catalog = createHostToolCatalog({});
  assert.match(searchableDomainText("integration-registry"), /mcp/i);
  assert.match(searchableDomainText("integration-registry"), /skill/i);
  const binding = { logicalSessionId: "logical:test", providerBindingId: "binding:test",
    sessionId: "session:test", agentId: "agent:test", sessionKind: "chat", state: "active" };
  const coordinator = new ToolHostMaterializationCoordinator({ store: {}, catalog,
    providerPort: {}, resolveBinding: async () => binding });
  for (const domainHint of ["mcp", "skill registration"]) {
    const found = await coordinator.search({ ...binding, domainHint,
      intent: "Register a local MCP server HTTP endpoint or install a Skill in Corptie" });
    assert.ok(found.domains.some((domain) => domain.domainId === "integration-registry"));
  }
  for (const providerId of ["codex-app-server", "claude-code", "openclacky"]) {
    const contract = catalog.domainContract({ ...scope, providerId }, "integration-registry");
    assert.deepEqual(contract.tools.map((tool) => tool.canonicalName).sort(), [
      "corptie_integration_list", "corptie_mcp_register", "corptie_skill_discover", "corptie_skill_register"
    ]);
    for (const entry of catalog.entries(scope, { domains: ["integration-registry"] })) {
      assert.deepEqual([...entry.eligibleSurfaces].sort(), ["generated_authenticated_mcp", "native_dynamic", "restricted_gateway"]);
    }
  }
  await assert.rejects(catalog.execute({ tool: "corptie_integration_list" }), { code: "SESSION_TOOL_FORBIDDEN" });
});

test("model registration uses real MCP and Skill installers, persists results and emits existing events", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-registration-tools-"));
  const store = new CorptieStore({ dbPath: join(root, "db.sqlite"), configPath: join(root, "config.json") });
  try {
    await store.initialize();
    const source = join(root, "skill-source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: test-registration\ndescription: Test registration workflow\n---\nTest instructions\n");
    const events = [];
    const catalog = createHostToolCatalog({
      mcpRegistryService: new McpRegistryService({ store }),
      skillRegistryService: new SkillRegistryService({ store, skillsDirs: { test: join(root, "runtime") }, cacheRoot: join(root, "cache") }),
      onIntegrationChanged: (type, payload) => events.push({ type, payload })
    });
    const call = (tool, args) => catalog.execute({ ...scope, tool, arguments: args });
    const input = { name: "test-stdio", transport: "stdio", command: process.execPath,
      cwd: root, args: [fileURLToPath(new URL("./fixtures/standaloneMcpServer.mjs", import.meta.url))], installRequestId: randomUUID() };
    const installed = await call("corptie_mcp_register", input);
    assert.equal(installed.assigned, false);
    assert.ok(installed.server.toolCount > 0);
    assert.equal((await call("corptie_mcp_register", input)).server.serverId, installed.server.serverId);
    await call("corptie_skill_discover", { sourceType: "local", source });
    const skill = await call("corptie_skill_register", { sourceType: "local", source });
    assert.equal(skill.assigned, false);
    const listed = await call("corptie_integration_list", {});
    assert.equal(listed.servers[0].serverId, installed.server.serverId);
    assert.equal(listed.skills[0].skillId, skill.skill.skillId);
    assert.deepEqual(events.map((event) => event.type), ["McpServerChanged", "SkillChanged"]);
    await assert.rejects(call("corptie_mcp_register", { ...input, headers: { Authorization: "secret" } }));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Streamable HTTP spelling is normalized before registration", async () => {
  let received;
  const catalog = createHostToolCatalog({ mcpRegistryService: {
    register: async (input) => { received = input; return { serverId: "mcp:test" }; }
  } });
  await catalog.execute({ ...scope, tool: "corptie_mcp_register", arguments: {
    name: "tradude", transport: "streamable-http", url: "http://127.0.0.1:8878/mcp"
  } });
  assert.equal(received.transport, "http");
});
