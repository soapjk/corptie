import assert from "node:assert/strict";
import test from "node:test";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";

function fakeClient(name, closed) {
  return {
    listTools: async () => ({
      tools: [{
        name: `${name}_lookup`, description: `Lookup through ${name}`,
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }]
    }),
    callTool: async (input) => ({ content: [{ type: "text", text: `${name}:${input.arguments.id}` }] }),
    close: async () => { closed.push(name); }
  };
}

test("MCP catalog fingerprints are keyed while credential rotation invalidates one gateway", async () => {
  let secret = "short-secret";
  const closed = [];
  const options = {
    resolveServers: async () => ({ private: { type: "http", url: "https://example.test/mcp",
      headers: { Authorization: secret } } }),
    connectServer: async (name) => fakeClient(name, closed)
  };
  const first = new SkillMcpGateway(options);
  const second = new SkillMcpGateway(options);
  const input = { actorId: "agent:1", providerId: "provider:1", intent: "lookup" };
  try {
    const before = (await first.search(input)).catalogVersion;
    assert.equal((await first.search(input)).catalogVersion, before);
    assert.notEqual((await second.search(input)).catalogVersion, before);
    assert.doesNotMatch(before, /short-secret/);
    secret = "rotated-secret";
    assert.notEqual((await first.search(input)).catalogVersion, before);
    assert.equal(closed.length, 1);
  } finally {
    await first.close();
    await second.close();
  }
});

test("Skill MCP gateway hot-swaps assigned servers without changing a Provider binding", async () => {
  let servers = {};
  let revision = "none";
  const closed = [];
  const gateway = new SkillMcpGateway({
    resolveServers: async () => servers,
    resolveRevision: () => revision,
    connectServer: async (name) => fakeClient(name, closed)
  });
  try {
    assert.deepEqual(await gateway.definitions({ actorId: "agent:1", providerId: "provider:1" }), []);
    servers = { investrace: { type: "stdio", command: "ignored" } };
    revision = "assigned";
    assert.equal(gateway.revision("agent:1"), "assigned");
    assert.deepEqual(
      (await gateway.definitions({ actorId: "agent:1", providerId: "provider:1" })).map((tool) => tool.name),
      ["investrace_lookup"]
    );
    const result = await gateway.execute({
      actorId: "agent:1", metadata: { providerId: "provider:1" },
      tool: "investrace_lookup", arguments: { id: "NVDA" }
    });
    assert.equal(result.content[0].text, "investrace:NVDA");
    servers = {};
    await assert.rejects(() => gateway.execute({
      actorId: "agent:1", metadata: { providerId: "provider:1" },
      tool: "investrace_lookup", arguments: { id: "NVDA" }
    }), { code: "HOST_TOOL_UNSUPPORTED" });
    assert.deepEqual(closed, ["investrace"]);
  } finally {
    await gateway.close();
  }
});

test("Skill MCP gateway namespaces duplicate tools across assigned packages", async () => {
  const closed = [];
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({ first: {}, second: {} }),
    connectServer: async (name) => ({
      listTools: async () => ({ tools: [{ name: "duplicate", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [{ type: "text", text: name }] }),
      close: async () => { closed.push(name); }
    })
  });
  try {
    const result = await gateway.search({ actorId: "agent:1", providerId: "provider:1" });
    assert.deepEqual(result.domains.map((domain) => domain.domainId), ["skill-mcp:first", "skill-mcp:second"]);
    assert.deepEqual(result.unavailableServers, []);
    const names = result.domains.flatMap((domain) => domain.tools.map((tool) => tool.canonicalName));
    assert.equal(new Set(names).size, 2);
    assert.ok(names.every((name) => /^skill_[a-f0-9]{20}__duplicate$/.test(name)));
    const responses = await Promise.all(names.map((name) => gateway.execute({
      actorId: "agent:1", providerId: "provider:1", tool: name, arguments: {}
    })));
    assert.deepEqual(new Set(responses.map((response) => response.content[0].text)),
      new Set(["first", "second"]));
    await assert.rejects(gateway.execute({ actorId: "agent:1", providerId: "provider:1",
      tool: "duplicate" }), { code: "HOST_TOOL_UNSUPPORTED" });
  } finally {
    await gateway.close();
  }
  assert.deepEqual(closed.sort(), ["first", "second"]);
});

test("two standalone MCP Servers and one Skill MCP can expose the same remote tool", async () => {
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({
      standalone_one: { serverId: "mcp:one" },
      standalone_two: { serverId: "mcp:two" },
      skill_bundled: {}
    }),
    connectServer: async (serverName) => ({
      listTools: async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [{ type: "text", text: serverName }] }),
      close: async () => {}
    })
  });
  try {
    const scope = { actorId: "agent:one", providerId: "provider:one" };
    const definitions = await gateway.definitions(scope);
    assert.deepEqual(definitions.map((tool) => tool.name), [
      "lookup", "standalone_one__lookup", "standalone_two__lookup"
    ]);
    const results = await Promise.all(definitions.map((tool) => gateway.execute({
      ...scope, tool: tool.name, arguments: {}
    })));
    assert.deepEqual(new Set(results.map((result) => result.content[0].text)),
      new Set(["skill_bundled", "standalone_one", "standalone_two"]));
  } finally {
    await gateway.close();
  }
});

test("Skill MCP gateway isolates a malformed tool list and keeps other servers callable", async () => {
  const closed = [];
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({ bad: {}, good: {} }),
    connectServer: async (name) => name === "bad" ? {
      listTools: async () => ({ tools: [{ name: "broken", inputSchema: { type: "string" } }] }),
      close: async () => { closed.push(name); }
    } : fakeClient(name, closed)
  });
  try {
    const scope = { actorId: "agent:1", providerId: "provider:1" };
    const result = await gateway.search(scope);
    assert.deepEqual(result.domains.map((domain) => domain.domainId), ["skill-mcp:good"]);
    assert.deepEqual(result.unavailableServers.map((server) => server.code), ["MCP_TOOL_SCHEMA_INVALID"]);
    assert.deepEqual(closed, ["bad"]);
    const called = await gateway.execute({ ...scope, tool: "good_lookup", arguments: { id: "ok" } });
    assert.equal(called.content[0].text, "good:ok");
  } finally {
    await gateway.close();
  }
});

test("a malformed conflicting Server cannot rename an earlier healthy Skill tool", async () => {
  const closed = [];
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({ healthy: {}, malformed: {} }),
    connectServer: async (name) => ({
      listTools: async () => ({ tools: name === "healthy"
        ? [{ name: "shared_lookup", inputSchema: { type: "object" } }]
        : [
          { name: "shared_lookup", inputSchema: { type: "object" } },
          { name: "broken", inputSchema: { type: "string" } }
        ] }),
      callTool: async () => ({ content: [{ type: "text", text: name }] }),
      close: async () => { closed.push(name); }
    })
  });
  try {
    const scope = { actorId: "agent:1", providerId: "provider:1" };
    const result = await gateway.search(scope);
    assert.deepEqual(result.domains.flatMap((domain) => domain.tools.map((tool) => tool.canonicalName)),
      ["shared_lookup"]);
    assert.deepEqual(result.unavailableServers.map((server) => server.code), ["MCP_TOOL_SCHEMA_INVALID"]);
    assert.equal((await gateway.execute({ ...scope, tool: "shared_lookup", arguments: {} }))
      .content[0].text, "healthy");
  } finally {
    await gateway.close();
  }
  assert.deepEqual(closed.sort(), ["healthy", "malformed"]);
});

test("Skill MCP gateway bounds one Server's tool list without hiding other Servers", async () => {
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({ oversized: {}, good: {} }),
    connectServer: async (name) => name === "oversized" ? {
      listTools: async () => ({ tools: Array.from({ length: 257 }, (_, index) => ({
        name: `tool_${index}`, inputSchema: { type: "object" }
      })) }),
      close: async () => {}
    } : fakeClient(name, [])
  });
  try {
    const result = await gateway.search({ actorId: "agent:1", providerId: "provider:1" });
    assert.deepEqual(result.domains.map((domain) => domain.domainId), ["skill-mcp:good"]);
    assert.deepEqual(result.unavailableServers.map((server) => server.code), ["MCP_TOOLS_TOO_MANY"]);
  } finally {
    await gateway.close();
  }
});

test("Skill MCP gateway exposes assigned tools as restricted-gateway discovery contracts", async () => {
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({ investrace: {} }),
    connectServer: async () => ({
      listTools: async () => ({ tools: [
        { name: "investrace_context", description: "Read portfolio context", inputSchema: { type: "object" } },
        { name: "investrace_diagnostics", description: "Inspect MCP health", inputSchema: { type: "object" } }
      ] }),
      close: async () => {}
    })
  });
  try {
    const result = await gateway.search({
      actorId: "agent:1", providerId: "provider:1", intent: "investrace portfolio"
    });
    assert.equal(result.domains.length, 1);
    assert.equal(result.domains[0].domainId, "skill-mcp:investrace");
    assert.equal(result.domains[0].recommendedTool, "investrace_diagnostics");
    assert.equal(result.domains[0].invocation.mode, "restricted_gateway");
    assert.match(result.domains[0].invocation.expectedCatalogVersion, /^skill-mcp:1:/);
    assert.deepEqual(result.domains[0].tools.map((tool) => tool.canonicalName), [
      "investrace_context", "investrace_diagnostics"
    ]);
  } finally {
    await gateway.close();
  }
});

test("Skill MCP gateway isolates an offline server and retries without an assignment change", async () => {
  const closed = [];
  let online = false;
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({
      standalone_offline: { displayName: "Offline Server" },
      standalone_working: { displayName: "Working Server" }
    }),
    retryMs: 0,
    connectServer: async (name) => {
      if (name === "standalone_offline" && !online) throw Object.assign(new Error("private transport detail"), { code: "ECONNREFUSED" });
      return fakeClient(name, closed);
    }
  });
  const scope = { actorId: "agent:1", providerId: "provider:1" };
  try {
    const first = await gateway.search(scope);
    assert.deepEqual(first.domains.map((domain) => domain.domainId), ["mcp:standalone_working"]);
    assert.deepEqual(first.unavailableServers.map((server) => server.code), ["ECONNREFUSED"]);
    const availability = await gateway.availability(scope);
    assert.deepEqual(availability.servers.map((server) => [server.domainId, server.available]), [
      ["mcp:standalone_offline", false], ["mcp:standalone_working", true]
    ]);
    assert.deepEqual(availability.servers[1].toolNames,
      ["standalone_working__standalone_working_lookup"]);
    assert.doesNotMatch(JSON.stringify(first), /private transport detail/);
    await assert.rejects(() => gateway.domain(scope, "mcp:standalone_offline"), { code: "MCP_SERVER_UNAVAILABLE" });
    const working = await gateway.execute({
      ...scope, tool: "standalone_working__standalone_working_lookup", arguments: { id: "ok" }
    });
    assert.equal(working.content[0].text, "standalone_working:ok");
    online = true;
    const recovered = await gateway.search(scope);
    assert.deepEqual(recovered.domains.map((domain) => domain.domainId), [
      "mcp:standalone_offline", "mcp:standalone_working"
    ]);
    assert.deepEqual(recovered.unavailableServers, []);
    assert.ok(closed.includes("standalone_working"));
  } finally {
    await gateway.close();
  }
});
