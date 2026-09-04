import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createCatalogBackedMcpServer } from "../src/mcp/catalogBackedMcpServer.mjs";

test("authenticated MCP lists only the latest applied catalog and delegates calls by canonical name", async () => {
  let tools = [{
    name: "corptie_tool_catalog_search", description: "search",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }];
  const calls = [];
  const observations = [];
  const server = createCatalogBackedMcpServer({
    pollIntervalMs: 0,
    client: {
      get: async (path, search) => {
        assert.equal(path, "/internal/session/tool/catalog");
        assert.match(search.observationId, /^[0-9a-f-]{36}$/);
        observations.push(search.observationId);
        return { tools };
      },
      post: async (path, body) => { calls.push({ path, body }); return { ok: true, canonical: body.tool }; }
    }
  });
  const client = new Client({ name: "catalog-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["corptie_tool_catalog_search"]);
    tools = [{
      name: "corptie_artifact_get", description: "get artifact",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }];
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["corptie_artifact_get"]);
    assert.equal(new Set(observations).size, 2);
    const result = await client.callTool({ name: "corptie_artifact_get", arguments: {} });
    assert.equal(result.structuredContent.canonical, "corptie_artifact_get");
    assert.deepEqual(calls, [{
      path: "/internal/session/tool",
      body: { tool: "corptie_artifact_get", arguments: {} }
    }]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("authenticated MCP announces an assignment-driven catalog revision change", async () => {
  let revision = "catalog:skills:none";
  let changed = 0;
  let announceChange;
  const server = createCatalogBackedMcpServer({
    client: {
      get: async (path) => path.endsWith("/revision")
        ? { revision }
        : { revision, tools: [] },
      post: async () => ({ ok: true }),
      subscribeCatalogChanges: (callback) => {
        announceChange = callback;
        return () => {};
      }
    }
  });
  const client = new Client({ name: "catalog-notification-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client.setNotificationHandler(
    ToolListChangedNotificationSchema,
    async () => { changed += 1; }
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.listTools();
    revision = "catalog:skills:assigned";
    await announceChange();
    assert.equal(changed, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
