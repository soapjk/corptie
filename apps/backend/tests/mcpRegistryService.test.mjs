import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { McpRegistryService } from "../src/application/mcpRegistryService.mjs";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-mcp-registry-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const service = new McpRegistryService({ store });
  service.verify = async (input) => ({ name: input.name, url: input.url, transport: input.transport,
    toolCount: 1, toolNames: ["lookup"] });
  return { directory, store, service };
}

test("standalone MCP registration, assignment and revocation change existing Agent tool visibility", async () => {
  const { directory, store, service } = await fixture();
  try {
    const agent = store.createAgent({ name: "MCP Test Agent", provider: "codex-app-server" });
    const server = await service.register({ name: "Calendar", url: "https://example.test/mcp", transport: "http" });
    assert.equal(service.list().length, 1);
    assert.deepEqual(service.serversForAgent(agent.agentId), {});
    const before = service.assignmentRevisionForAgent(agent.agentId);
    service.setAssignment(agent.agentId, server.serverId, true);
    assert.notEqual(service.assignmentRevisionForAgent(agent.agentId), before);
    const [key] = Object.keys(service.serversForAgent(agent.agentId));
    assert.match(key, /^standalone_[a-f0-9]{32}$/);
    assert.equal(service.serversForAgent(agent.agentId)[key].displayName, "Calendar");
    assert.throws(() => service.remove(server.serverId), { code: "MCP_SERVER_ASSIGNED" });
    service.setEnabled(server.serverId, false);
    assert.deepEqual(service.serversForAgent(agent.agentId), {});
    service.setEnabled(server.serverId, true);

    const gateway = new SkillMcpGateway({
      resolveServers: async () => service.serversForAgent(agent.agentId),
      connectServer: async () => ({
        listTools: async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: async () => {}
      })
    });
    try {
      const input = { actorId: agent.agentId, providerId: "codex-app-server", intent: "Calendar lookup" };
      const found = await gateway.search(input);
      assert.equal(found.domains[0].domainId, `mcp:${key}`);
      const canonical = found.domains[0].tools[0].canonicalName;
      assert.equal(canonical, `${key}__lookup`);
      assert.equal((await gateway.execute({ ...input, tool: canonical, arguments: {} })).content[0].text, "ok");
      service.setAssignment(agent.agentId, server.serverId, false);
      await assert.rejects(() => gateway.execute({ ...input, tool: canonical, arguments: {} }),
        { code: "HOST_TOOL_UNSUPPORTED" });
    } finally {
      await gateway.close();
    }
    assert.equal(service.remove(server.serverId).removed, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone MCP URL validation rejects credentials and non-loopback HTTP", async () => {
  const { directory, store } = await fixture();
  try {
    const service = new McpRegistryService({ store });
    await assert.rejects(() => service.verify({ name: "Bad", transport: "http", url: "http://example.test/mcp" }),
      { code: "MCP_URL_INVALID" });
    await assert.rejects(() => service.verify({ name: "Bad", transport: "http", url: "https://token@example.test/mcp" }),
      { code: "MCP_URL_INVALID" });
    await assert.rejects(() => service.verify({ name: "Bad", transport: "http", url: "https://example.test/mcp?token=secret" }),
      { code: "MCP_URL_INVALID" });
    await assert.rejects(() => service.verify({ name: "Bad", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "secret" } }),
      { code: "MCP_CREDENTIALS_UNSUPPORTED" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two standalone Servers with the same remote tool name keep distinct canonical tools", async () => {
  const { directory, store, service } = await fixture();
  try {
    const agent = store.createAgent({ name: "Two Servers", provider: "claude-sdk" });
    const first = await service.register({ name: "First", url: "https://first.example.test/mcp", transport: "http" });
    const second = await service.register({ name: "Second", url: "https://second.example.test/mcp", transport: "http" });
    service.setAssignment(agent.agentId, first.serverId, true);
    service.setAssignment(agent.agentId, second.serverId, true);
    const gateway = new SkillMcpGateway({
      resolveServers: async () => service.serversForAgent(agent.agentId),
      connectServer: async (name) => ({
        listTools: async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [{ type: "text", text: name }] }),
        close: async () => {}
      })
    });
    try {
      const input = { actorId: agent.agentId, providerId: "claude-sdk" };
      const definitions = await gateway.definitions(input);
      assert.equal(definitions.length, 2);
      assert.notEqual(definitions[0].name, definitions[1].name);
      const results = await Promise.all(definitions.map((definition) => gateway.execute({
        ...input, tool: definition.name, arguments: {}
      })));
      assert.notEqual(results[0].content[0].text, results[1].content[0].text);
    } finally {
      await gateway.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real loopback MCP Server verifies, installs and calls through the existing gateway", async () => {
  const listener = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const server = new McpServer({ name: "standalone-fixture", version: "1.0.0" });
    server.registerTool("ping", { description: "Read-only connectivity check", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, JSON.parse(body));
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    } finally {
      await transport.close();
      await server.close();
    }
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { directory, store } = await fixture();
  try {
    const service = new McpRegistryService({ store });
    const agent = store.createAgent({ name: "Loopback", provider: "codex-app-server" });
    const address = listener.address();
    const config = { name: "Local fixture", transport: "http", url: `http://127.0.0.1:${address.port}/mcp` };
    const verification = await service.verify(config);
    assert.deepEqual(verification.toolNames, ["ping"]);
    const installed = await service.register(config);
    service.setAssignment(agent.agentId, installed.serverId, true);
    const gateway = new SkillMcpGateway({
      resolveServers: async () => service.serversForAgent(agent.agentId)
    });
    try {
      const input = { actorId: agent.agentId, providerId: "codex-app-server", intent: "ping" };
      const found = await gateway.search(input);
      const canonical = found.domains[0].tools[0].canonicalName;
      const result = await gateway.execute({ ...input, tool: canonical, arguments: {} },
        { expectedCatalogVersion: found.catalogVersion });
      assert.equal(result.content[0].text, "pong");
      service.setAssignment(agent.agentId, installed.serverId, false);
      await assert.rejects(() => gateway.execute({ ...input, tool: canonical, arguments: {} }),
        { code: "HOST_TOOL_UNSUPPORTED" });
    } finally {
      await gateway.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
    await new Promise((resolve) => listener.close(resolve));
  }
});

test("pure stdio MCP without SKILL.md installs and runs with an isolated environment", async () => {
  const { directory, store } = await fixture();
  try {
    const service = new McpRegistryService({ store });
    const agent = store.createAgent({ name: "Local MCP", provider: "claude-sdk" });
    const config = { name: "Local tool", transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/standaloneMcpServer.mjs", import.meta.url))],
      cwd: fileURLToPath(new URL("..", import.meta.url)) };
    const verified = await service.verify(config);
    assert.deepEqual(verified.toolNames, ["ping"]);
    const installed = await service.register(config);
    service.setAssignment(agent.agentId, installed.serverId, true);
    const gateway = new SkillMcpGateway({ resolveServers: async () => service.serversForAgent(agent.agentId) });
    try {
      const input = { actorId: agent.agentId, providerId: "claude-sdk", intent: "Local tool ping" };
      const found = await gateway.search(input);
      const canonical = found.domains[0].tools[0].canonicalName;
      const called = await gateway.execute({ ...input, tool: canonical, arguments: {} });
      assert.equal(called.content[0].text, "pong");
    } finally {
      await gateway.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stdio schema migration preserves an existing remote MCP and Agent assignment", async () => {
  const { directory, store } = await fixture();
  try {
    const agent = store.createAgent({ name: "Migrated MCP", provider: "codex-app-server" });
    store.db.run("PRAGMA foreign_keys = OFF");
    store.db.run("DROP TABLE agent_mcp_assignments");
    store.db.run("DROP TABLE mcp_server_registry");
    store.db.run(`CREATE TABLE mcp_server_registry (
      server_id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('http', 'sse')),
      enabled INTEGER NOT NULL DEFAULT 1, tool_count INTEGER NOT NULL,
      verified_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    store.db.run(`CREATE TABLE agent_mcp_assignments (
      agent_id TEXT NOT NULL, server_id TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, server_id),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES mcp_server_registry(server_id) ON DELETE RESTRICT
    )`);
    store.db.run("PRAGMA foreign_keys = ON");
    store.db.run(`INSERT INTO mcp_server_registry VALUES
      ('mcp:legacy', 'Legacy', 'https://example.test/mcp', 'http', 1, 1, 'now', 'now', 'now')`);
    store.db.run("INSERT INTO agent_mcp_assignments VALUES (?, 'mcp:legacy', 'now')", [agent.agentId]);
    store.ensureSkillTables();
    const service = new McpRegistryService({ store });
    assert.equal(service.get("mcp:legacy").name, "Legacy");
    assert.deepEqual(service.listForAgent(agent.agentId), ["mcp:legacy"]);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
    assert.match(store.selectOne(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_server_registry'"
    ).sql, /'stdio'/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
