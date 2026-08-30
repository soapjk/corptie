import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCollaborationMcpServer } from "../src/mcp/collaborationMcpServer.mjs";

test("legacy collaboration factory is a catalog-backed compatibility alias with no handwritten tools", async () => {
  const calls = [];
  const server = createCollaborationMcpServer({
    client: {
      get: async (path) => {
        assert.equal(path, "/internal/session/tool/catalog");
        return { tools: [{
          name: "corptie_collaboration_request",
          description: "Catalog-owned request contract",
          inputSchema: {
            type: "object", properties: { title: { type: "string" } },
            required: ["title"], additionalProperties: false
          }
        }] };
      },
      post: async (path, body) => { calls.push({ path, body }); return { status: "sent" }; }
    }
  });
  const client = new Client({ name: "compat-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["corptie_collaboration_request"]);
    const receipt = await client.callTool({ name: "corptie_collaboration_request", arguments: { title: "Review" } });
    assert.equal(receipt.structuredContent.status, "sent");
    assert.deepEqual(calls, [{
      path: "/internal/session/tool",
      body: { tool: "corptie_collaboration_request", arguments: { title: "Review" } }
    }]);
  } finally {
    await client.close();
    await server.close();
  }
});
