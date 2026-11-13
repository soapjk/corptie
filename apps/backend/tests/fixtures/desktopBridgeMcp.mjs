import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "desktop-bridge-fixture", version: "1" }, {
  capabilities: { tools: {} }, instructions: "Use the computer-only cua interface." });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "js", description: "Execute a desktop operation", inputSchema: { type: "object", properties: { code: { type: "string" } } } }
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const reply = await server.request({ method: "elicitation/create", params: {
    mode: "form", message: "Allow fixture application?", requestedSchema: { type: "object", properties: {} },
    _meta: { connector_id: "computer-use", tool_params: { app: "fixture.app" }, persist: ["session"] }
  } }, ElicitResultSchema);
  if (reply.action !== "accept") return { isError: true, content: [{ type: "text", text: "declined-before-action" }] };
  return { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, meta: request.params._meta ?? null }) },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }] };
});
await server.connect(new StdioServerTransport());
