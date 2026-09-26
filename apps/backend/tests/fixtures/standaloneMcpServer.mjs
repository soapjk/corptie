import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "standalone-stdio-fixture", version: "1.0.0" });
server.registerTool("ping", { description: "Read-only local connectivity check", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: process.env.CORPTIE_HOME ? "environment-leak" : "pong" }] }));
await server.connect(new StdioServerTransport());
