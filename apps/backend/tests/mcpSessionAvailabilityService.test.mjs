import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { McpSessionAvailabilityService } from "../src/application/mcpSessionAvailabilityService.mjs";
import { handleMcpRegistryHttpRequest } from "../src/application/mcpRegistryHttpApi.mjs";

const logical = {
  logicalSessionId: "logical:old", legacySessionId: "codex:old", sessionName: "投资大师_Session",
  activeBinding: { bindingId: "binding:old", providerId: "codex-app-server", state: "active" }
};

function fakeStore(overrides = {}) {
  return {
    getLogicalSession: (id) => id === logical.logicalSessionId ? logical : null,
    getLogicalSessionByName: (name) => name === logical.sessionName ? logical : null,
    getSession: () => ({ agentId: "agent:investor" }),
    getAgent: () => ({ agentId: "agent:investor" }),
    getSessionToolCatalogMaterialization: () => ({ status: "applied" }),
    ...overrides
  };
}

test("Session MCP availability diagnoses its active Agent and Provider without replacing the binding", async () => {
  const calls = [];
  const service = new McpSessionAvailabilityService({ store: fakeStore(), gateway: {
    availability: async (input) => {
      calls.push(input);
      return { catalogVersion: "catalog:v1", servers: [
        { serverName: "investrace", domainId: "skill-mcp:investrace", available: true,
          errorCode: null, toolNames: ["investrace_context"] },
        { serverName: "standalone_offline", domainId: "mcp:standalone_offline", available: false,
          errorCode: "MCP_CONNECTION_FAILED", toolNames: [] }
      ] };
    }
  } });
  const found = await service.inspect("投资大师_Session");
  assert.equal(found.logicalSessionId, "logical:old");
  assert.equal(found.bindingId, "binding:old");
  assert.equal(found.toolHostStatus, "applied");
  assert.equal(found.status, "degraded");
  assert.deepEqual(found.servers.map((server) => server.available), [true, false]);
  assert.deepEqual(calls, [{ actorId: "agent:investor", providerId: "codex-app-server",
    metadata: { logicalSessionId: "logical:old", bindingId: "binding:old" } }]);
  assert.doesNotMatch(JSON.stringify(found), /secret|Bearer/);
});

test("Session MCP availability reports route and gateway failures without raw transport details", async () => {
  const noRoute = new McpSessionAvailabilityService({ store: fakeStore({
    getLogicalSession: () => ({ ...logical, activeBinding: null })
  }), gateway: { availability: async () => { throw new Error("must not connect"); } } });
  assert.equal((await noRoute.inspect("logical:old")).errorCode, "MCP_SESSION_BINDING_INACTIVE");
  const failing = new McpSessionAvailabilityService({ store: fakeStore(), gateway: {
    availability: async () => { throw new Error("private endpoint and token"); }
  } });
  const result = await failing.inspect("logical:old");
  assert.equal(result.errorCode, "MCP_DIAGNOSTIC_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /private endpoint|token/);
  await assert.rejects(() => failing.inspect("missing"), { code: "SESSION_NOT_FOUND" });
});

test("Session MCP availability distinguishes an assigned Skill whose MCP descriptor resolves to no Server", async () => {
  const service = new McpSessionAvailabilityService({ store: fakeStore({
    listRegistrySkillsForAgent: () => [{ skillId: "skill:investrace", name: "investrace",
      mcpDescriptorSubpath: ".mcp.json" }]
  }), gateway: {
    availability: async () => ({ catalogVersion: "v1", servers: [] })
  } });
  const result = await service.inspect("投资大师_Session");
  assert.equal(result.status, "assigned_mcp_unresolved");
  assert.equal(result.errorCode, "MCP_ASSIGNED_SERVER_UNRESOLVED");
  assert.deepEqual(result.declaredSkills, [{ skillId: "skill:investrace", name: "investrace" }]);
});

test("Session MCP availability does not call a Server usable when its Agent allows no tools", async () => {
  const service = new McpSessionAvailabilityService({ store: fakeStore(), gateway: {
    availability: async () => ({ catalogVersion: "v1", servers: [
      { serverName: "standalone_restricted", available: true, toolNames: [],
        toolPolicy: "none", errorCode: null }
    ] })
  } });
  const result = await service.inspect("投资大师_Session");
  assert.equal(result.status, "no_tools_allowed");
  assert.equal(result.servers[0].toolPolicy, "none");
});

test("Session MCP availability HTTP route accepts an exact Session name", async () => {
  const request = Readable.from([]);
  request.method = "GET";
  let status;
  let body;
  const response = {
    writeHead(value) { status = value; return this; },
    end(value) { body = JSON.parse(value); }
  };
  const service = new McpSessionAvailabilityService({ store: fakeStore(), gateway: {
    availability: async () => ({ catalogVersion: "v1", servers: [] })
  } });
  await handleMcpRegistryHttpRequest({ request, response,
    url: new URL(`http://localhost/sessions/${encodeURIComponent("投资大师_Session")}/mcp-availability`),
    availabilityService: service });
  assert.equal(status, 200);
  assert.equal(body.availability.status, "no_mcp_assigned");
  assert.equal(body.availability.sessionName, "投资大师_Session");
});

test("Session MCP availability query accepts names without placing them in a path segment", async () => {
  const request = Readable.from([]);
  request.method = "GET";
  let status;
  let body;
  const response = {
    writeHead(value) { status = value; return this; },
    end(value) { body = JSON.parse(value); }
  };
  const url = new URL("http://localhost/mcp-availability");
  url.searchParams.set("session", "投资大师_Session");
  await handleMcpRegistryHttpRequest({ request, response, url,
    availabilityService: new McpSessionAvailabilityService({ store: fakeStore(), gateway: {
      availability: async () => ({ catalogVersion: "v1", servers: [] })
    } }) });
  assert.equal(status, 200);
  assert.equal(body.availability.logicalSessionId, "logical:old");
});
