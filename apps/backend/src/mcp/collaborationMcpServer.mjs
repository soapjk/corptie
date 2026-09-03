import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CollaborationHttpClient } from "./collaborationHttpClient.mjs";
import { createCatalogBackedMcpServer } from "./catalogBackedMcpServer.mjs";

// Compatibility export for callers that historically imported the collaboration
// MCP factory. Tool Host now owns every definition returned by tools/list.
export const createCollaborationMcpServer = createCatalogBackedMcpServer;

async function main() {
  const client = new CollaborationHttpClient({
    agentId: required(process.env.CORPTIE_AGENT_ID, "CORPTIE_AGENT_ID"),
    sessionScope: {
      sessionId: required(process.env.CORPTIE_SESSION_ID, "CORPTIE_SESSION_ID"),
      providerBindingId: required(process.env.CORPTIE_PROVIDER_BINDING_ID, "CORPTIE_PROVIDER_BINDING_ID"),
      workId: process.env.CORPTIE_WORK_ID,
      taskId: process.env.CORPTIE_TASK_ID
    }
  });
  await createCatalogBackedMcpServer({ client }).connect(new StdioServerTransport());
}

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[corptie-tool-host-mcp] ${error.message}`);
    process.exitCode = 1;
  });
}
