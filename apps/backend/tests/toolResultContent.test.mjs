import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { codexDynamicToolResult, normalizeMcpToolResult } from "../src/application/toolResultContent.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { createCatalogBackedMcpServer } from "../src/mcp/catalogBackedMcpServer.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = () => ({ type: "image", mimeType: "image/png", data: PNG });

test("ordinary business results keep their existing JSON text semantics", () => {
  const value = { ok: true, result: { content: [{ type: "image", url: "https://private.invalid" }] } };
  assert.deepEqual(codexDynamicToolResult(value), {
    success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }]
  });
  assert.deepEqual(normalizeMcpToolResult(value).structuredContent, value);
  assert.equal(codexDynamicToolResult({ content: [{ type: "text", text: "denied" }], isError: true }).success, false);
});

test("Codex receives raster images as native image inputs without base64 JSON copies", () => {
  const value = { content: [{ type: "text", text: "Target application" }, image()],
    structuredContent: { screenshot: PNG }, _meta: { "codex/toolSurface": { kind: "computerUse" } } };
  const normalized = normalizeMcpToolResult(value);
  assert.equal(normalized.structuredContent, undefined);
  assert.deepEqual(normalized._meta, value._meta);
  assert.equal(value.structuredContent.screenshot, PNG);
  assert.deepEqual(codexDynamicToolResult(value), {
    success: true,
    contentItems: [{ type: "inputText", text: "Target application" },
      { type: "inputImage", imageUrl: `data:image/png;base64,${PNG}` }]
  });
});

test("malformed, remote, mismatched and oversized tool images fail without embedding bytes in errors", () => {
  for (const block of [
    { ...image(), mimeType: "image/svg+xml" },
    { ...image(), data: "https://private.invalid/image.png" },
    { ...image(), data: "A===" },
    { ...image(), data: Buffer.from("not a PNG").toString("base64") },
    { ...image(), mimeType: "image/jpeg" },
    { ...image(), data: "A".repeat(12 * 1024 * 1024) }
  ]) {
    assert.throws(() => codexDynamicToolResult({ content: [block] }), error => {
      assert.equal(error.code, "TOOL_IMAGE_INVALID");
      assert.ok(error.message.length < 100);
      assert.ok(!error.message.includes(PNG));
      return true;
    });
  }
  assert.throws(() => normalizeMcpToolResult({ content: Array.from({ length: 5 }, image) }),
    error => error.code === "TOOL_IMAGE_INVALID");
  const hugeDimensions = Buffer.from(PNG, "base64");
  hugeDimensions.writeUInt32BE(65535, 16);
  assert.throws(() => normalizeMcpToolResult({ content: [{ ...image(), data: hugeDimensions.toString("base64") }] }),
    error => error.code === "TOOL_IMAGE_INVALID");
});

test("Codex dynamic tool dispatch preserves multimodal results and propagates MCP failure", async () => {
  const responses = [];
  let result = { content: [image()] };
  const client = new CodexAppServerClient({ onDynamicToolCall: async () => result });
  client.dynamicToolAgentsByThread.set("thread-test", "agent-test");
  client.respondToServerRequest = async (id, value) => responses.push({ id, value });
  const message = { id: 1, params: { threadId: "thread-test", turnId: "turn-test", tool: "corptie_tool_call" } };
  await client.handleDynamicToolCall(message);
  assert.equal(responses[0].value.contentItems[0].type, "inputImage");
  result = { content: [{ type: "text", text: "App access denied" }], isError: true };
  await client.handleDynamicToolCall({ ...message, id: 2 });
  assert.equal(responses[1].value.success, false);
  result = { content: [{ ...image(), data: "INVALID" }] };
  await client.handleDynamicToolCall({ ...message, id: 3 });
  assert.equal(responses[2].value.success, false);
  assert.equal(JSON.parse(responses[2].value.contentItems[0].text).code, "TOOL_IMAGE_INVALID");
});

test("authenticated catalog MCP preserves native raster blocks for MCP Providers", async () => {
  const server = createCatalogBackedMcpServer({ pollIntervalMs: 0,
    client: { post: async () => ({ content: [image()], structuredContent: { duplicate: PNG } }) } });
  const client = new Client({ name: "tool-image-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "corptie_tool_call", arguments: {} });
    assert.deepEqual(result.content, [image()]);
    assert.equal(result.structuredContent, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});
