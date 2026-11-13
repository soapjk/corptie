import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "approval-protocol-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "confirm", inputSchema: { type: "object" } }
] }));
server.setRequestHandler(CallToolRequestSchema, async () => {
  const reply = await server.request({ method: "elicitation/create", params: {
    message: "Allow the test application?", requestedSchema: { type: "object", properties: {} },
    _meta: { connector_id: "computer-use", tool_params: { app: "fixture.app" }, persist: ["session"] }
  } }, ElicitResultSchema);
  return { content: [{ type: "text", text: JSON.stringify(reply) }] };
});
await server.connect(new StdioServerTransport());
