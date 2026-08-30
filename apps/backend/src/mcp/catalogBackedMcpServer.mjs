import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function createCatalogBackedMcpServer(options = {}) {
  if (!options.client) throw new TypeError("Catalog-backed MCP requires an authenticated backend client.");
  const client = options.client;
  const server = new Server(
    { name: "corptie-tool-host", version: "0.6.0" },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: "Tool definitions are supplied exclusively by the authoritative Corptie Tool Host catalog for this exact Session and Provider binding."
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await client.get("/internal/session/tool/catalog", {
      observationId: randomUUID()
    });
    return { tools: (result.tools ?? []).map(toMcpDefinition) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await client.post("/internal/session/tool", {
        tool: request.params.name,
        arguments: request.params.arguments ?? {}
      });
      if (request.params.name === "corptie_tool_domain_load"
        && ["applying", "applied"].includes(result?.status)) {
        await server.sendToolListChanged();
      }
      return normalizeToolResult(result);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ code: error.code ?? "SESSION_TOOL_FAILED", error: error.message }) }]
      };
    }
  });
  return server;
}

function toMcpDefinition(definition) {
  return {
    name: definition.name,
    description: definition.description ?? "",
    inputSchema: definition.inputSchema,
    ...(definition.annotations ? { annotations: definition.annotations } : {})
  };
}

function normalizeToolResult(result) {
  if (Array.isArray(result?.content)) return result;
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? {}) }],
    ...(result && typeof result === "object" ? { structuredContent: result } : {})
  };
}
