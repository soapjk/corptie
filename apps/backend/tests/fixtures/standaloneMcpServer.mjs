import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "standalone-stdio-fixture", version: "1.0.0" });
server.registerTool("ping", { description: "Read-only local connectivity check", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: process.env.MCP_TEST_SECRET
    ? "credential-present" : process.env.CORPTIE_HOME ? "environment-leak" : "pong" }] }));
if (process.argv[2] === "many-tools") {
  for (let index = 0; index < 256; index += 1) {
    server.registerTool(`extra_${index}`, { inputSchema: {} }, async () => ({ content: [] }));
  }
}
await server.connect(new StdioServerTransport());
