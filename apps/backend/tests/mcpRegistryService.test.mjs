import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { McpRegistryService } from "../src/application/mcpRegistryService.mjs";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";
import { handleMcpRegistryHttpRequest } from "../src/application/mcpRegistryHttpApi.mjs";

test("MCP verification rejects a null or array configuration as client input", async () => {
  const service = new McpRegistryService({ store: {} });
  await assert.rejects(() => service.verify(null), { code: "INVALID_INPUT", statusCode: 400 });
  await assert.rejects(() => service.verify([]), { code: "INVALID_INPUT", statusCode: 400 });
});

test("browser origins cannot call local MCP management or Session diagnostics", async () => {
  const calls = [];
  for (const [method, path] of [
    ["POST", "/mcp-servers"],
    ["PUT", "/agents/agent%3Aone/mcp-servers/mcp%3Aone"],
    ["GET", "/sessions/logical%3Aone/mcp-availability"]
  ]) {
    const request = Readable.from(["{}"]).on("error", () => {});
    request.method = method;
    request.headers = { origin: "https://untrusted.example" };
    let status;
    let body;
    await handleMcpRegistryHttpRequest({ request,
      response: {
        writeHead(value) { status = value; return this; },
        end(value) { body = JSON.parse(value); }
      },
      url: new URL(`http://localhost${path}`),
      service: { register: () => calls.push("register"), setAssignment: () => calls.push("assign") },
      availabilityService: { inspect: () => calls.push("inspect") }
    });
    assert.equal(status, 403);
    assert.equal(body.code, "MCP_BROWSER_ORIGIN_FORBIDDEN");
  }
  assert.deepEqual(calls, []);
});

test("MCP management preserves UTF-8 across request chunks and limits raw body bytes", async () => {
  const input = Buffer.from(JSON.stringify({ name: "中文 MCP" }));
  const splitAt = input.indexOf(Buffer.from("中")) + 1;
  let seen;
  const responseFor = () => {
    const result = { status: null, body: null };
    result.response = {
      writeHead(status) { result.status = status; return this; },
      end(value) { result.body = JSON.parse(value); }
    };
    return result;
  };
  const splitRequest = Readable.from([input.subarray(0, splitAt), input.subarray(splitAt)]);
  splitRequest.method = "POST";
  const accepted = responseFor();
  await handleMcpRegistryHttpRequest({ request: splitRequest, response: accepted.response,
    url: new URL("http://localhost/mcp-servers/verify"),
    service: { verify: async (value) => { seen = value; return { toolCount: 1 }; } } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(seen, { name: "中文 MCP" });

  const oversizedRequest = Readable.from([Buffer.from(JSON.stringify({ name: "中".repeat(22_000) }))]);
  oversizedRequest.method = "POST";
  const rejected = responseFor();
  await handleMcpRegistryHttpRequest({ request: oversizedRequest, response: rejected.response,
    url: new URL("http://localhost/mcp-servers/verify"),
    service: { verify: async () => { throw new Error("oversized body reached verifier"); } } });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.code, "REQUEST_TOO_LARGE");
});

test("installed MCP check API returns the recorded status without a listening socket", async () => {
  const request = Readable.from([]);
  request.method = "POST";
  let status;
  let body;
  const response = {
    writeHead(value) { status = value; return this; },
    end(value) { body = JSON.parse(value); }
  };
  const seen = [];
  await handleMcpRegistryHttpRequest({
    request, response, url: new URL("http://localhost/mcp-servers/mcp%3A123/verify"),
    service: { checkInstallation: async (id) => ({ serverId: id, lastCheckStatus: "unavailable" }) },
    onChanged: (type, payload) => seen.push({ type, payload })
  });
  assert.equal(status, 200);
  assert.equal(body.server.serverId, "mcp:123");
  assert.equal(body.server.lastCheckStatus, "unavailable");
  assert.equal(seen[0].type, "McpServerChanged");
});

test("MCP package management API routes discovery and selected installation", async () => {
  const calls = [];
  async function invoke(path, input) {
    const request = Readable.from([JSON.stringify(input)]);
    request.method = "POST";
    let status;
    let body;
    const response = {
      writeHead(value) { status = value; return this; },
      end(value) { body = JSON.parse(value); }
    };
    await handleMcpRegistryHttpRequest({
      request, response, url: new URL(`http://localhost${path}`),
      service: {
        discoverPackage: async (value) => { calls.push({ action: "discover", value }); return { candidates: [] }; },
        registerPackage: async (value) => { calls.push({ action: "install", value }); return { serverId: "mcp:installed" }; }
      }
    });
    return { status, body };
  }
  assert.deepEqual(await invoke("/mcp-servers/discover", { sourceType: "local", source: "/tmp/source" }),
    { status: 200, body: { discovery: { candidates: [] } } });
  assert.deepEqual(await invoke("/mcp-servers/package", { sourceType: "local", serverName: "ping" }),
    { status: 201, body: { server: { serverId: "mcp:installed" } } });
  assert.deepEqual(calls.map((call) => call.action), ["discover", "install"]);
});

test("idempotent install replay returns the existing Server without another change event", async () => {
  const events = [];
  const request = Readable.from([JSON.stringify({ installRequestId: "cd30712b-e41b-4694-aea7-789101009ad7" })]);
  request.method = "POST";
  let status;
  let body;
  await handleMcpRegistryHttpRequest({
    request,
    response: {
      writeHead(value) { status = value; return this; },
      end(value) { body = JSON.parse(value); }
    },
    url: new URL("http://localhost/mcp-servers"),
    service: { register: async () => ({ serverId: "mcp:existing", idempotentReplay: true }) },
    onChanged: (...args) => events.push(args)
  });
  assert.equal(status, 200);
  assert.equal(body.server.serverId, "mcp:existing");
  assert.deepEqual(events, []);
});

test("MCP deletion impact API returns a read-only preview", async () => {
  const request = Readable.from([]);
  request.method = "GET";
  let status;
  let body;
  await handleMcpRegistryHttpRequest({
    request,
    response: {
      writeHead(value) { status = value; return this; },
      end(value) { body = JSON.parse(value); }
    },
    url: new URL("http://localhost/mcp-servers/mcp%3Aone/deletion-impact"),
    service: { deletionImpact: (id) => ({ serverId: id, canRemove: false,
      blockingCode: "MCP_SERVER_ASSIGNED" }) }
  });
  assert.equal(status, 200);
  assert.deepEqual(body.impact, { serverId: "mcp:one", canRemove: false,
    blockingCode: "MCP_SERVER_ASSIGNED" });
});

test("MCP runtime events API returns only bounded stored receipts", async () => {
  const request = Readable.from([]);
  request.method = "GET";
  let status;
  let body;
  await handleMcpRegistryHttpRequest({
    request,
    response: {
      writeHead(value) { status = value; return this; },
      end(value) { body = JSON.parse(value); }
    },
    url: new URL("http://localhost/mcp-servers/mcp%3Aone/runtime-events?limit=5"),
    service: { runtimeEvents: (id, limit) => [{ serverId: id, toolCount: limit }] }
  });
  assert.equal(status, 200);
  assert.deepEqual(body.events, [{ serverId: "mcp:one", toolCount: 5 }]);
});

test("Agent MCP assignment API accepts an optional private credential override", async () => {
  const calls = [];
  for (const body of [null, { headers: { Authorization: "Bearer agent-only" } }]) {
    const request = Readable.from(body ? [JSON.stringify(body)] : []);
    request.method = "PUT";
    let status;
    await handleMcpRegistryHttpRequest({
      request,
      response: { writeHead(value) { status = value; return this; }, end() {} },
      url: new URL("http://localhost/agents/agent%3Aone/mcp-servers/mcp%3Aone"),
      service: { setAssignment: (...args) => { calls.push(args); return { assigned: true }; } }
    });
    assert.equal(status, 200);
  }
  assert.deepEqual(calls, [
    ["agent:one", "mcp:one", true, {}],
    ["agent:one", "mcp:one", true, { headers: { Authorization: "Bearer agent-only" } }]
  ]);
});

test("MCP PATCH routes configuration updates separately from enable toggles", async () => {
  const calls = [];
  async function patch(body) {
    const request = Readable.from([JSON.stringify(body)]);
    request.method = "PATCH";
    let responseBody;
    const response = {
      writeHead() { return this; },
      end(value) { responseBody = JSON.parse(value); }
    };
    await handleMcpRegistryHttpRequest({
      request, response, url: new URL("http://localhost/mcp-servers/mcp%3Aone"),
      service: {
        setEnabled: (id, enabled) => { calls.push(["enabled", id, enabled]); return { enabled }; },
        updateConfig: async (id, input) => { calls.push(["config", id, input]); return { configRevision: 2 }; }
      }
    });
    return responseBody;
  }
  assert.deepEqual(await patch({ enabled: false }), { server: { enabled: false } });
  assert.deepEqual(await patch({ expectedConfigRevision: 1, name: "New" }),
    { server: { configRevision: 2 } });
  assert.deepEqual(calls.map(([action]) => action), ["enabled", "config"]);
});

test("idempotent MCP enable and Agent assignment do not broadcast change events", async () => {
  const events = [];
  for (const [method, path, input, service] of [
    ["PATCH", "/mcp-servers/mcp%3Aone", { enabled: true },
      { setEnabled: () => ({ serverId: "mcp:one", enabled: true, idempotentReplay: true }) }],
    ["PUT", "/agents/agent%3Aone/mcp-servers/mcp%3Aone", {},
      { setAssignment: () => ({ agentId: "agent:one", serverId: "mcp:one", assigned: true, changed: false }) }]
  ]) {
    const request = Readable.from([JSON.stringify(input)]);
    request.method = method;
    let status;
    await handleMcpRegistryHttpRequest({ request,
      response: { writeHead(value) { status = value; return this; }, end() {} },
      url: new URL(`http://localhost${path}`), service,
      onChanged: (...event) => events.push(event) });
    assert.equal(status, 200);
  }
  assert.deepEqual(events, []);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-mcp-registry-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const service = new McpRegistryService({ store });
  service.verify = async (input) => ({ name: input.name, url: input.url, transport: input.transport,
    toolCount: 1, toolNames: ["lookup"] });
  return { directory, store, service };
}

test("direct MCP install retries and concurrent requests retain one Server", async () => {
  const { directory, store, service } = await fixture();
  try {
    const input = { name: "Retry", transport: "http", url: "https://example.test/mcp",
      installRequestId: "cd30712b-e41b-4694-aea7-789101009ad7" };
    const [first, second] = await Promise.all([service.register(input), service.register(input)]);
    assert.equal(first.serverId, second.serverId);
    assert.equal(Number(Boolean(first.idempotentReplay)) + Number(Boolean(second.idempotentReplay)), 1);
    assert.equal(service.list().length, 1);
    service.verify = async () => { throw new Error("A retry must not reconnect."); };
    const replay = await service.register(input);
    assert.equal(replay.serverId, first.serverId);
    assert.equal(replay.idempotentReplay, true);
    await assert.rejects(() => service.register({ ...input, installRequestId: "bad" }),
      { code: "MCP_INSTALL_REQUEST_INVALID" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic event write failure cannot turn a verified installation into a false failure", async () => {
  const { directory, store, service } = await fixture();
  try {
    service.recordRuntimeEvent = () => { throw new Error("diagnostic store unavailable"); };
    const installed = await service.register({ name: "Healthy", transport: "http",
      url: "https://example.test/mcp" });
    assert.equal(installed.lastCheckStatus, "available");
    const checked = await service.checkInstallation(installed.serverId);
    assert.equal(checked.lastCheckStatus, "available");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct MCP credentials stay out of SQLite and rotate without changing Server identity", async () => {
  const { directory, store, service } = await fixture();
  const secrets = new Map();
  service.secretStore = {
    put(account, value) { secrets.set(account, structuredClone(value)); },
    get(account) { return secrets.get(account) ?? null; },
    delete(account) { secrets.delete(account); }
  };
  try {
    const agent = store.createAgent({ name: "Credential Agent", provider: "codex-app-server" });
    const installed = await service.register({ name: "Secured", transport: "http",
      url: "https://example.test/mcp", headers: { Authorization: "Bearer original-secret" } });
    assert.equal(installed.hasCredentials, true);
    assert.deepEqual(installed.credentialNames, ["Authorization"]);
    assert.doesNotMatch(JSON.stringify(installed), /original-secret|credentialRef/);
    service.setAssignment(agent.agentId, installed.serverId, true);
    assert.equal(Object.values(service.serversForAgent(agent.agentId))[0].headers.Authorization,
      "Bearer original-secret");
    const changed = await service.updateConfig(installed.serverId, {
      expectedConfigRevision: installed.configRevision, name: "Secured v2",
      headers: { Authorization: "Bearer rotated-secret" }
    });
    assert.equal(changed.serverId, installed.serverId);
    assert.equal(changed.configRevision, 2);
    assert.equal(secrets.size, 1);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM mcp_cleanup_queue").count, 0);
    assert.equal(Object.values(service.serversForAgent(agent.agentId))[0].headers.Authorization,
      "Bearer rotated-secret");
    assert.doesNotMatch(await readFile(join(directory, "db.sqlite"), "utf8"), /original-secret|rotated-secret/);
    service.setAssignment(agent.agentId, installed.serverId, false);
    await service.remove(installed.serverId);
    assert.equal(secrets.size, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing MCP credential isolates only its assigned Server", async () => {
  const { directory, store, service } = await fixture();
  const secrets = new Map();
  service.secretStore = {
    put(account, value) { secrets.set(account, value); },
    get(account) { return secrets.get(account) ?? null; },
    delete(account) { secrets.delete(account); }
  };
  try {
    const agent = store.createAgent({ name: "Credential Isolation", provider: "claude-sdk" });
    const secured = await service.register({ name: "Secured", transport: "http",
      url: "https://example.test/secured", headers: { Authorization: "Bearer value" } });
    const publicServer = await service.register({ name: "Public", transport: "http",
      url: "https://example.test/public" });
    service.setAssignment(agent.agentId, secured.serverId, true);
    service.setAssignment(agent.agentId, publicServer.serverId, true);
    secrets.clear();
    const servers = service.serversForAgent(agent.agentId);
    assert.equal(Object.values(servers).filter((server) => server.unavailableCode).length, 1);
    const gateway = new SkillMcpGateway({
      resolveServers: async () => servers,
      connectServer: async () => ({
        listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
        close: async () => {}
      })
    });
    try {
      const result = await gateway.search({ actorId: agent.agentId, providerId: "claude-sdk" });
      assert.equal(result.domains.length, 1);
      assert.equal(result.unavailableServers.length, 1);
      assert.equal(result.unavailableServers[0].code, "MCP_CREDENTIAL_MISSING");
    } finally { await gateway.close(); }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two Agents may use separate Keychain-backed MCP credentials without sharing or leaking values", async () => {
  const { directory, store, service } = await fixture();
  const secrets = new Map();
  service.secretStore = {
    put(account, value) { secrets.set(account, structuredClone(value)); },
    get(account) { return secrets.get(account) ?? null; },
    delete(account) { secrets.delete(account); }
  };
  try {
    const first = store.createAgent({ name: "First", provider: "codex-app-server" });
    const second = store.createAgent({ name: "Second", provider: "codex-app-server" });
    const server = await service.register({ name: "Shared", transport: "http",
      url: "https://example.test/mcp", headers: { Authorization: "Bearer install-level" } });
    service.setAssignment(first.agentId, server.serverId, true,
      { headers: { Authorization: "Bearer first-agent" } });
    service.setAssignment(second.agentId, server.serverId, true);
    const firstRevision = service.assignmentRevisionForAgent(first.agentId);
    assert.equal(Object.values(service.serversForAgent(first.agentId))[0].headers.Authorization,
      "Bearer first-agent");
    assert.equal(Object.values(service.serversForAgent(second.agentId))[0].headers.Authorization,
      "Bearer install-level");
    assert.deepEqual(service.assignmentDetailsForAgent(first.agentId)[0].credentialNames,
      ["Authorization"]);
    assert.doesNotMatch(JSON.stringify(service.assignmentDetailsForAgent(first.agentId)), /first-agent|credential_ref/);
    const firstCredentialRef = store.selectOne(`SELECT credential_ref FROM agent_mcp_assignments
      WHERE agent_id = ? AND server_id = ?`, [first.agentId, server.serverId]).credential_ref;
    secrets.delete(firstCredentialRef);
    assert.equal(Object.values(service.serversForAgent(first.agentId))[0].unavailableCode,
      "MCP_CREDENTIAL_MISSING");
    assert.equal(Object.values(service.serversForAgent(second.agentId))[0].unavailableCode, null);
    service.setAssignment(first.agentId, server.serverId, true,
      { headers: { Authorization: "Bearer rotated-agent" } });
    assert.notEqual(service.assignmentRevisionForAgent(first.agentId), firstRevision);
    await service.drainCleanup({ serverId: server.serverId });
    assert.equal(Object.values(service.serversForAgent(first.agentId))[0].headers.Authorization,
      "Bearer rotated-agent");
    assert.equal(Object.values(service.serversForAgent(second.agentId))[0].headers.Authorization,
      "Bearer install-level");
    service.setAssignment(first.agentId, server.serverId, false);
    await service.drainCleanup({ serverId: server.serverId });
    assert.equal(secrets.size, 1);
    assert.doesNotMatch(await readFile(join(directory, "db.sqlite"), "utf8"),
      /first-agent|rotated-agent|install-level/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent deletion queues its MCP credential for safe Keychain cleanup", async () => {
  const { directory, store, service } = await fixture();
  const secrets = new Map();
  service.secretStore = {
    put(account, value) { secrets.set(account, structuredClone(value)); },
    get(account) { return secrets.get(account) ?? null; },
    delete(account) { secrets.delete(account); }
  };
  try {
    const agent = store.createAgent({ name: "Temporary", provider: "codex-app-server" });
    const server = await service.register({ name: "Remote", transport: "http",
      url: "https://example.test/mcp" });
    service.setAssignment(agent.agentId, server.serverId, true,
      { headers: { Authorization: "Bearer temporary" } });
    assert.equal(secrets.size, 1);
    store.deleteAgent(agent.agentId);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM mcp_cleanup_queue").count, 1);
    assert.equal(await service.drainCleanup({ serverId: server.serverId }), 0);
    assert.equal(secrets.size, 0);
    assert.equal(service.get(server.serverId)?.name, "Remote");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed cleanup item does not starve later queued MCP credentials", async () => {
  const { directory, store, service } = await fixture();
  const attempted = [];
  service.secretStore = {
    put() {}, get() { return null; },
    delete(account) {
      attempted.push(account);
      if (account === "mcp:stuck") throw new Error("Keychain temporarily unavailable");
    }
  };
  try {
    const server = await service.register({ name: "Cleanup", transport: "http",
      url: "https://example.test/mcp" });
    for (const [target, createdAt] of [["mcp:stuck", "2026-01-01T00:00:00Z"],
      ["mcp:later", "2026-01-02T00:00:00Z"]]) {
      store.db.run(`INSERT INTO mcp_cleanup_queue
        (cleanup_kind, target, server_id, created_at) VALUES ('credential_ref', ?, ?, ?)`,
      [target, server.serverId, createdAt]);
    }
    assert.equal(await service.drainCleanup({ limit: 1 }), 2);
    assert.equal(await service.drainCleanup({ limit: 1 }), 1);
    assert.deepEqual(attempted, ["mcp:stuck", "mcp:later"]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent credential rotations cannot delete the winning Keychain value", async () => {
  const { directory, store, service } = await fixture();
  const secrets = new Map();
  service.secretStore = {
    put(account, value) { secrets.set(account, structuredClone(value)); },
    get(account) { return secrets.get(account) ?? null; },
    delete(account) { secrets.delete(account); }
  };
  try {
    const installed = await service.register({ name: "Original", transport: "http",
      url: "https://example.test/mcp", headers: { Authorization: "Bearer original" } });
    let ready = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    service.verify = async (input) => {
      ready += 1;
      if (ready === 2) release();
      await barrier;
      return { name: input.name, url: input.url, transport: input.transport,
        toolCount: 1, toolNames: ["lookup"] };
    };
    const attempts = await Promise.allSettled(["First", "Second"].map((name) => service.updateConfig(
      installed.serverId, { expectedConfigRevision: installed.configRevision, name,
        headers: { Authorization: `Bearer ${name}` } }
    )));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected")[0].reason.code, "MCP_CONFIG_STALE");
    assert.equal(secrets.size, 1);
    const winner = service.get(installed.serverId);
    assert.equal([...secrets.values()][0].headers.Authorization, `Bearer ${winner.name}`);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone MCP registration, assignment and revocation change existing Agent tool visibility", async () => {
  const { directory, store, service } = await fixture();
  try {
    const agent = store.createAgent({ name: "MCP Test Agent", provider: "codex-app-server" });
    const server = await service.register({ name: "Calendar", url: "https://example.test/mcp", transport: "http" });
    assert.equal(service.list().length, 1);
    assert.deepEqual(service.serversForAgent(agent.agentId), {});
    const before = service.assignmentRevisionForAgent(agent.agentId);
    assert.equal(service.setAssignment(agent.agentId, server.serverId, true).changed, true);
    assert.deepEqual(service.deletionImpact(server.serverId).assignedAgents,
      [{ agentId: agent.agentId, name: "MCP Test Agent" }]);
    assert.equal(service.deletionImpact(server.serverId).canRemove, false);
    const unchangedAssignmentRevision = service.assignmentRevisionForAgent(agent.agentId);
    assert.equal(service.setAssignment(agent.agentId, server.serverId, true).changed, false);
    assert.equal(service.assignmentRevisionForAgent(agent.agentId), unchangedAssignmentRevision);
    assert.notEqual(service.assignmentRevisionForAgent(agent.agentId), before);
    const [key] = Object.keys(service.serversForAgent(agent.agentId));
    assert.match(key, /^standalone_[a-f0-9]{32}$/);
    assert.equal(service.serversForAgent(agent.agentId)[key].displayName, "Calendar");
    await assert.rejects(() => service.remove(server.serverId), { code: "MCP_SERVER_ASSIGNED" });
    assert.equal(service.setEnabled(server.serverId, false).idempotentReplay, undefined);
    const disabledAt = service.get(server.serverId).updatedAt;
    assert.equal(service.setEnabled(server.serverId, false).idempotentReplay, true);
    assert.equal(service.get(server.serverId).updatedAt, disabledAt);
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
      assert.equal(service.deletionImpact(server.serverId).canRemove, true);
      await assert.rejects(() => gateway.execute({ ...input, tool: canonical, arguments: {} }),
        { code: "HOST_TOOL_UNSUPPORTED" });
    } finally {
      await gateway.close();
    }
    assert.equal((await service.remove(server.serverId)).removed, true);
    assert.deepEqual(await service.remove(server.serverId), {
      serverId: server.serverId, removed: false, cleanupPending: false
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone MCP runtime receipts correlate tools/list and calls without recording arguments", async () => {
  const { directory, store, service } = await fixture();
  try {
    const agent = store.createAgent({ name: "Receipt Agent", provider: "codex-app-server" });
    const server = await service.register({ name: "Receipt Server", transport: "http",
      url: "https://example.test/mcp" });
    service.setAssignment(agent.agentId, server.serverId, true);
    const gateway = new SkillMcpGateway({
      resolveServers: async () => service.serversForAgent(agent.agentId),
      onRuntimeEvent: (event) => service.recordRuntimeEvent(event),
      connectServer: async () => ({
        listTools: async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: async () => {}
      })
    });
    try {
      const input = { actorId: agent.agentId, providerId: "codex-app-server",
        metadata: { logicalSessionId: "logical:receipt", bindingId: "binding:receipt" },
        intent: "lookup" };
      const discovered = await gateway.search(input);
      assert.equal(discovered.domains.length, 1);
      await gateway.execute({ ...input, tool: discovered.domains[0].tools[0].canonicalName,
        arguments: { token: "never-store-this" } });
      const events = service.runtimeEvents(server.serverId);
      assert.deepEqual(events.map((event) => event.stage).sort(), ["tool-call", "tools-list", "tools-list"]);
      assert.ok(events.filter((event) => event.logicalSessionId).every((event) => event.logicalSessionId === "logical:receipt"
        && event.bindingId === "binding:receipt" && event.agentId === agent.agentId));
      assert.equal(events.at(-1).logicalSessionId, null);
      assert.equal(service.latestRuntimeEvent(server.serverId, "tools-list")?.status, "success");
      assert.equal(service.latestRuntimeEvent(server.serverId, "tool-call", "logical:receipt")?.toolName,
        "lookup");
      assert.equal(service.latestRuntimeEvent(server.serverId, "tool-call", "logical:other"), null);
      assert.doesNotMatch(JSON.stringify(events), /never-store-this/);
      assert.doesNotMatch(await readFile(join(directory, "db.sqlite"), "utf8"), /never-store-this/);
    } finally {
      await gateway.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed MCP checks record safe failure and recovery without disabling assignments", async () => {
  const { directory, store, service } = await fixture();
  try {
    const agent = store.createAgent({ name: "Check Agent", provider: "codex-app-server" });
    const installed = await service.register({ name: "Check Server", url: "https://example.test/mcp", transport: "http" });
    service.setAssignment(agent.agentId, installed.serverId, true);
    service.verify = async () => {
      throw Object.assign(new Error("secret endpoint details"), { code: "MCP_CONNECTION_FAILED" });
    };
    const failed = await service.checkInstallation(installed.serverId);
    assert.equal(failed.lastCheckStatus, "unavailable");
    assert.equal(failed.lastErrorCode, "MCP_CONNECTION_FAILED");
    assert.equal(failed.enabled, true);
    assert.deepEqual(service.listForAgent(agent.agentId), [installed.serverId]);
    assert.doesNotMatch(JSON.stringify(failed), /secret endpoint details/);
    service.verify = async (input) => ({ ...input, toolCount: 2, toolNames: ["lookup", "search"] });
    const recovered = await service.checkInstallation(installed.serverId);
    assert.equal(recovered.lastCheckStatus, "available");
    assert.equal(recovered.lastErrorCode, null);
    assert.equal(recovered.toolCount, 2);
    assert.deepEqual(recovered.observedToolNames, ["lookup", "search"]);
    assert.equal(service.list()[0].lastCheckStatus, "available");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct MCP configuration update verifies before CAS switch and preserves the Server identity", async () => {
  const { directory, store, service } = await fixture();
  try {
    const agent = store.createAgent({ name: "Update Agent", provider: "codex-app-server" });
    const installed = await service.register({ name: "Before", transport: "http", url: "https://old.example.test/mcp" });
    service.setAssignment(agent.agentId, installed.serverId, true);
    const beforeRevision = service.assignmentRevisionForAgent(agent.agentId);
    service.verify = async () => { throw Object.assign(new Error("offline"), { code: "MCP_CONNECTION_FAILED" }); };
    await assert.rejects(() => service.updateConfig(installed.serverId, {
      expectedConfigRevision: installed.configRevision, name: "After", url: "https://new.example.test/mcp"
    }), { code: "MCP_CONNECTION_FAILED" });
    assert.equal(service.get(installed.serverId).url, installed.url);
    assert.equal(service.get(installed.serverId).configRevision, 1);
    service.verify = async (input) => ({ ...input, toolCount: 2, toolNames: ["search", "read"] });
    const updated = await service.updateConfig(installed.serverId, {
      expectedConfigRevision: 1, name: "After", url: "https://new.example.test/mcp"
    });
    assert.equal(updated.serverId, installed.serverId);
    assert.equal(updated.name, "After");
    assert.equal(updated.configRevision, 2);
    assert.equal(service.serversForAgent(agent.agentId)[Object.keys(service.serversForAgent(agent.agentId))[0]].url,
      "https://new.example.test/mcp");
    assert.notEqual(service.assignmentRevisionForAgent(agent.agentId), beforeRevision);
    await assert.rejects(() => service.updateConfig(installed.serverId, {
      expectedConfigRevision: 1, name: "Stale"
    }), { code: "MCP_CONFIG_STALE" });
    assert.equal(service.get(installed.serverId).name, "After");
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
    await assert.rejects(() => service.verify({ name: "Bad", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "bad\r\nvalue" } }),
      { code: "MCP_CREDENTIALS_INVALID" });
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

test("Agent tool allowlist revokes an old canonical MCP tool without changing its Provider binding", async () => {
  const { directory, store, service } = await fixture();
  try {
    service.verify = async (input) => ({ name: input.name, transport: input.transport,
      url: input.url, toolCount: 2, toolNames: ["read", "write"] });
    const agent = store.createAgent({ name: "Limited", provider: "codex-app-server" });
    const server = await service.register({ name: "Two tools", transport: "http",
      url: "https://example.test/mcp" });
    await assert.rejects(async () => service.setAssignment(agent.agentId, server.serverId, true,
      { toolAllowlist: ["unknown"] }), { code: "MCP_TOOL_ALLOWLIST_INVALID" });
    service.setAssignment(agent.agentId, server.serverId, true, { toolAllowlist: ["read"] });
    const gateway = new SkillMcpGateway({
      resolveServers: async () => service.serversForAgent(agent.agentId),
      connectServer: async () => ({
        listTools: async () => ({ tools: [
          { name: "read", inputSchema: { type: "object" } },
          { name: "write", inputSchema: { type: "object" } }
        ] }),
        callTool: async ({ name }) => ({ content: [{ type: "text", text: name }] }),
        close: async () => {}
      })
    });
    try {
      const scope = { actorId: agent.agentId, providerId: "codex-app-server", intent: "" };
      const firstCatalog = await gateway.search(scope);
      assert.equal(firstCatalog.domains[0].tools.length, 1);
      const oldTool = firstCatalog.domains[0].tools[0].canonicalName;
      assert.match(oldTool, /__read$/);
      service.setAssignment(agent.agentId, server.serverId, true, { toolAllowlist: ["write"] });
      await assert.rejects(() => gateway.execute({ ...scope, tool: oldTool, arguments: {} }),
        { code: "HOST_TOOL_UNSUPPORTED" });
      const nextCatalog = await gateway.search(scope);
      assert.notEqual(nextCatalog.catalogVersion, firstCatalog.catalogVersion);
      assert.match(nextCatalog.domains[0].tools[0].canonicalName, /__write$/);
      assert.deepEqual(service.assignmentDetailsForAgent(agent.agentId)[0].toolAllowlist, ["write"]);
      service.setAssignment(agent.agentId, server.serverId, true, { toolAllowlist: [] });
      assert.deepEqual((await gateway.search(scope)).domains, []);
      service.setAssignment(agent.agentId, server.serverId, true, { toolAllowlist: null });
      assert.equal((await gateway.search(scope)).domains[0].tools.length, 2);
    } finally {
      await gateway.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real loopback MCP Server verifies, installs and calls through the existing gateway", async (context) => {
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
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    context.skip("This sandbox does not permit a loopback listener; run on a local development host.");
    return;
  }
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

test("MCP installation rejects a Server exposing more than 256 tools", async () => {
  const { directory, store } = await fixture();
  try {
    const service = new McpRegistryService({ store });
    const config = { name: "Too many tools", transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/standaloneMcpServer.mjs", import.meta.url)), "many-tools"],
      cwd: fileURLToPath(new URL("..", import.meta.url)) };
    await assert.rejects(() => service.verify(config), { code: "MCP_TOOLS_TOO_MANY" });
    assert.deepEqual(service.list(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pure MCP package installs a selected stdio Server into managed storage and runs after source removal", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "source");
  try {
    await mkdir(source);
    const fixtureSource = await readFile(fileURLToPath(new URL("./fixtures/standaloneMcpServer.mjs", import.meta.url)), "utf8");
    const script = fixtureSource
      .replace("@modelcontextprotocol/sdk/server/mcp.js",
        new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", import.meta.url).href)
      .replace("@modelcontextprotocol/sdk/server/stdio.js",
        new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href);
    await writeFile(join(source, "server.mjs"), script);
    await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: {
      ping: { command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] }
    } }));
    const service = new McpRegistryService({ store, packageRoot: join(directory, "managed") });
    const discovery = await service.discoverPackage({ sourceType: "local", source });
    assert.deepEqual(discovery.candidates.map((candidate) => candidate.serverName), ["ping"]);
    assert.match(discovery.contentHash, /^[a-f0-9]{64}$/);
    await assert.rejects(() => service.registerPackage({ sourceType: "local", source,
      serverName: "ping", expectedContentHash: "0".repeat(64) }), { code: "MCP_PACKAGE_CHANGED" });
    const installInput = { sourceType: "local", source, serverName: "ping",
      expectedContentHash: discovery.contentHash,
      installRequestId: "8ef9413c-9103-46ae-8bcc-8cb6b4922f0e" };
    const installed = await service.registerPackage(installInput);
    assert.equal(installed.sourceKind, "local_package");
    assert.match(installed.packageHash, /^[a-f0-9]{64}$/);
    assert.notEqual(installed.packageRoot, source);
    await rm(source, { recursive: true, force: true });
    const replay = await service.registerPackage(installInput);
    assert.equal(replay.serverId, installed.serverId);
    assert.equal(replay.idempotentReplay, true);
    const agent = store.createAgent({ name: "Package MCP", provider: "codex-app-server" });
    service.setAssignment(agent.agentId, installed.serverId, true);
    const gateway = new SkillMcpGateway({ resolveServers: async () => service.serversForAgent(agent.agentId) });
    try {
      const input = { actorId: agent.agentId, providerId: "codex-app-server", intent: "ping" };
      const found = await gateway.search(input);
      assert.equal(found.domains.length, 1);
      const canonical = found.domains[0].tools[0].canonicalName;
      assert.equal((await gateway.execute({ ...input, tool: canonical, arguments: {} })).content[0].text, "pong");
    } finally {
      await gateway.close();
    }
    service.setAssignment(agent.agentId, installed.serverId, false);
    assert.equal((await service.remove(installed.serverId)).cleanupPending, false);
    await assert.rejects(() => stat(installed.packageRoot), { code: "ENOENT" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pure MCP package receives Keychain-backed environment credentials after source removal", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "secured-source");
  const secrets = new Map();
  try {
    await mkdir(source);
    const fixtureSource = await readFile(fileURLToPath(new URL("./fixtures/standaloneMcpServer.mjs", import.meta.url)), "utf8");
    const script = fixtureSource
      .replace("@modelcontextprotocol/sdk/server/mcp.js",
        new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", import.meta.url).href)
      .replace("@modelcontextprotocol/sdk/server/stdio.js",
        new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href);
    await writeFile(join(source, "server.mjs"), script);
    await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: {
      secured: { command: "node", args: ["${PLUGIN_ROOT}/server.mjs"],
        env: { MCP_TEST_SECRET: "${MCP_TEST_SECRET}" } }
    } }));
    const service = new McpRegistryService({ store, packageRoot: join(directory, "managed"),
      secretStore: {
        put(account, value) { secrets.set(account, structuredClone(value)); },
        get(account) { return secrets.get(account) ?? null; },
        delete(account) { secrets.delete(account); }
      } });
    const discovery = await service.discoverPackage({ sourceType: "local", source });
    assert.deepEqual(discovery.candidates[0].credentialNames, ["MCP_TEST_SECRET"]);
    const selected = { sourceType: "local", source, serverName: "secured",
      expectedContentHash: discovery.contentHash };
    await assert.rejects(() => service.registerPackage(selected), { code: "MCP_PACKAGE_CREDENTIAL_REQUIRED" });
    const installed = await service.registerPackage({ ...selected, env: { MCP_TEST_SECRET: "private-token" } });
    assert.equal(installed.hasCredentials, true);
    assert.doesNotMatch(JSON.stringify(installed), /private-token|credentialRef/);
    assert.equal(secrets.size, 1);
    await rm(source, { recursive: true, force: true });
    const agent = store.createAgent({ name: "Secured package", provider: "claude-sdk" });
    service.setAssignment(agent.agentId, installed.serverId, true);
    const gateway = new SkillMcpGateway({ resolveServers: async () => service.serversForAgent(agent.agentId) });
    try {
      const scope = { actorId: agent.agentId, providerId: "claude-sdk", intent: "ping" };
      const found = await gateway.search(scope);
      const called = await gateway.execute({ ...scope, tool: found.domains[0].tools[0].canonicalName,
        arguments: {} });
      assert.equal(called.content[0].text, "credential-present");
    } finally { await gateway.close(); }
    assert.doesNotMatch(await readFile(join(directory, "db.sqlite"), "utf8"), /private-token/);
    service.setAssignment(agent.agentId, installed.serverId, false);
    await service.remove(installed.serverId);
    assert.equal(secrets.size, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote MCP package binds supplied Header credentials without persisting their values", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "remote-source");
  const secrets = new Map();
  try {
    await mkdir(source);
    await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: {
      remote: { type: "http", url: "https://example.test/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" } }
    } }));
    const service = new McpRegistryService({ store, packageRoot: join(directory, "managed"),
      secretStore: {
        put(account, value) { secrets.set(account, value); },
        get(account) { return secrets.get(account) ?? null; },
        delete(account) { secrets.delete(account); }
      } });
    let expectedAuthorization = "Bearer private-token";
    service.verify = async (config) => {
      assert.equal(config.headers.Authorization, expectedAuthorization);
      return { name: config.name, transport: config.transport, url: config.url,
        toolCount: 1, toolNames: ["lookup"] };
    };
    const discovery = await service.discoverPackage({ sourceType: "local", source });
    assert.deepEqual(discovery.candidates[0].credentialNames, ["Authorization"]);
    const installed = await service.registerPackage({ sourceType: "local", source,
      serverName: "remote", expectedContentHash: discovery.contentHash,
      headers: { Authorization: "Bearer private-token" } });
    assert.equal(installed.hasCredentials, true);
    assert.doesNotMatch(JSON.stringify(installed), /private-token/);
    const agent = store.createAgent({ name: "Remote MCP", provider: "codex-app-server" });
    service.setAssignment(agent.agentId, installed.serverId, true);
    assert.equal(Object.values(service.serversForAgent(agent.agentId))[0].headers.Authorization,
      "Bearer private-token");
    assert.doesNotMatch(await readFile(join(directory, "db.sqlite"), "utf8"), /private-token/);
    await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: {
      remote: { type: "http", url: "https://example.test/v2",
        headers: { Authorization: "Bearer ${TOKEN}" } }
    } }));
    const next = await service.discoverPackage({ sourceType: "local", source });
    expectedAuthorization = "Bearer rotated-token";
    const updated = await service.updatePackage(installed.serverId, {
      sourceType: "local", source, serverName: "remote", expectedContentHash: next.contentHash,
      expectedConfigRevision: installed.configRevision,
      headers: { Authorization: expectedAuthorization }
    });
    assert.equal(secrets.size, 1);
    assert.equal(service.listPackageVersions(installed.serverId)[1].credentialsAvailable, false);
    const rolledBack = await service.rollbackPackage(installed.serverId, {
      expectedConfigRevision: updated.configRevision, targetRevision: installed.configRevision
    });
    assert.equal(rolledBack.url, "https://example.test/mcp");
    assert.equal(Object.values(service.serversForAgent(agent.agentId))[0].headers.Authorization,
      "Bearer rotated-token");
    assert.equal(secrets.size, 1);
    service.setAssignment(agent.agentId, installed.serverId, false);
    await service.remove(installed.serverId);
    assert.equal(secrets.size, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("package update keeps Server identity, assignment, and a versioned rollback source", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "versioned-source");
  try {
    await mkdir(source);
    const descriptor = (version) => JSON.stringify({ mcpServers: {
      remote: { type: "http", url: `https://example.test/${version}` }
    } });
    await writeFile(join(source, ".mcp.json"), descriptor("v1"));
    const service = new McpRegistryService({ store, packageRoot: join(directory, "managed") });
    service.verify = async (config) => ({ name: config.name, url: config.url,
      transport: config.transport, toolCount: 1, toolNames: ["lookup"] });
    const firstDiscovery = await service.discoverPackage({ sourceType: "local", source });
    const installed = await service.registerPackage({ sourceType: "local", source,
      serverName: "remote", expectedContentHash: firstDiscovery.contentHash });
    const agent = store.createAgent({ name: "Versioned MCP", provider: "codex-app-server" });
    service.setAssignment(agent.agentId, installed.serverId, true);
    const oldRevision = service.assignmentRevisionForAgent(agent.agentId);
    await writeFile(join(source, ".mcp.json"), descriptor("v2"));
    const nextDiscovery = await service.discoverPackage({ sourceType: "local", source });
    const updated = await service.updatePackage(installed.serverId, { sourceType: "local", source,
      serverName: "remote", expectedContentHash: nextDiscovery.contentHash,
      expectedConfigRevision: installed.configRevision });
    assert.equal(updated.serverId, installed.serverId);
    assert.equal(updated.url, "https://example.test/v2");
    assert.equal(updated.configRevision, installed.configRevision + 1);
    assert.notEqual(updated.packageRoot, installed.packageRoot);
    assert.notEqual(service.assignmentRevisionForAgent(agent.agentId), oldRevision);
    assert.deepEqual(service.listForAgent(agent.agentId), [installed.serverId]);
    assert.deepEqual(service.listPackageVersions(installed.serverId).map((version) => version.revision), [2, 1]);
    assert.equal((await stat(installed.packageRoot)).isDirectory(), true);
    assert.equal((await stat(updated.packageRoot)).isDirectory(), true);
    await assert.rejects(() => service.updatePackage(installed.serverId, { sourceType: "local", source,
      serverName: "remote", expectedContentHash: nextDiscovery.contentHash,
      expectedConfigRevision: installed.configRevision }), { code: "MCP_CONFIG_STALE" });
    await assert.rejects(() => service.rollbackPackage(installed.serverId, {
      expectedConfigRevision: updated.configRevision, targetRevision: installed.configRevision,
      env: { WRONG_KIND: "value" }
    }), { code: "INVALID_INPUT" });
    const rolledBack = await service.rollbackPackage(installed.serverId, {
      expectedConfigRevision: updated.configRevision, targetRevision: installed.configRevision
    });
    assert.equal(rolledBack.serverId, installed.serverId);
    assert.equal(rolledBack.url, "https://example.test/v1");
    assert.equal(rolledBack.packageRoot, installed.packageRoot);
    assert.equal(rolledBack.configRevision, 3);
    assert.deepEqual(service.listPackageVersions(installed.serverId).map((version) => version.revision), [3, 2, 1]);
    assert.deepEqual(service.listForAgent(agent.agentId), [installed.serverId]);
    service.setAssignment(agent.agentId, installed.serverId, false);
    await service.remove(installed.serverId);
    await assert.rejects(() => stat(installed.packageRoot), { code: "ENOENT" });
    await assert.rejects(() => stat(updated.packageRoot), { code: "ENOENT" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("package history retains only five versions and removes unreferenced managed copies", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "bounded-source");
  try {
    await mkdir(source);
    const service = new McpRegistryService({ store, packageRoot: join(directory, "managed") });
    service.verify = async (config) => ({ name: config.name, url: config.url,
      transport: config.transport, toolCount: 1, toolNames: ["lookup"] });
    let current;
    let firstRoot;
    for (let version = 1; version <= 9; version += 1) {
      await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: {
        remote: { type: "http", url: `https://example.test/v${version}` }
      } }));
      const discovery = await service.discoverPackage({ sourceType: "local", source });
      current = version === 1
        ? await service.registerPackage({ sourceType: "local", source,
          serverName: "remote", expectedContentHash: discovery.contentHash })
        : await service.updatePackage(current.serverId, { sourceType: "local", source,
          serverName: "remote", expectedContentHash: discovery.contentHash,
          expectedConfigRevision: current.configRevision });
      if (version === 1) firstRoot = current.packageRoot;
      assert.equal(current.cleanupPending ?? false, false);
    }
    assert.deepEqual(service.listPackageVersions(current.serverId).map((item) => item.revision),
      [9, 8, 7, 6, 5, 4]);
    await assert.rejects(() => stat(firstRoot), { code: "ENOENT" });
    await assert.rejects(() => service.rollbackPackage(current.serverId, {
      expectedConfigRevision: current.configRevision, targetRevision: 1
    }), { code: "MCP_PACKAGE_VERSION_NOT_FOUND" });
    await service.remove(current.serverId);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM mcp_cleanup_queue").count, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed credential cleanup stays queued and succeeds after service recreation", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "cleanup-source");
  const secrets = new Map();
  let failDelete = true;
  const secretStore = {
    put(account, value) { secrets.set(account, value); },
    get(account) { return secrets.get(account) ?? null; },
    delete(account) {
      if (failDelete) throw new Error("temporarily unavailable");
      secrets.delete(account);
    }
  };
  try {
    await mkdir(source);
    const service = new McpRegistryService({ store, packageRoot: join(directory, "managed"), secretStore });
    service.verify = async (config) => ({ name: config.name, url: config.url,
      transport: config.transport, toolCount: 1, toolNames: ["lookup"] });
    const descriptor = (version) => JSON.stringify({ mcpServers: {
      remote: { type: "http", url: `https://example.test/v${version}`,
        headers: { Authorization: "Bearer ${TOKEN}" } }
    } });
    await writeFile(join(source, ".mcp.json"), descriptor(1));
    const first = await service.discoverPackage({ sourceType: "local", source });
    const installed = await service.registerPackage({ sourceType: "local", source,
      serverName: "remote", expectedContentHash: first.contentHash,
      headers: { Authorization: "Bearer original" } });
    await writeFile(join(source, ".mcp.json"), descriptor(2));
    const second = await service.discoverPackage({ sourceType: "local", source });
    const updated = await service.updatePackage(installed.serverId, { sourceType: "local", source,
      serverName: "remote", expectedContentHash: second.contentHash,
      expectedConfigRevision: installed.configRevision,
      headers: { Authorization: "Bearer rotated" } });
    assert.equal(updated.cleanupPending, true);
    assert.equal(secrets.size, 2);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM mcp_cleanup_queue").count, 1);
    failDelete = false;
    const restarted = new McpRegistryService({ store, packageRoot: join(directory, "managed"), secretStore });
    assert.equal(await restarted.drainCleanup(), 0);
    assert.equal(secrets.size, 1);
    assert.equal([...secrets.values()][0].headers.Authorization, "Bearer rotated");
    await restarted.remove(installed.serverId);
    assert.equal(secrets.size, 0);
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
