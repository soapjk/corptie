import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function createCatalogBackedMcpServer(options = {}) {
  if (!options.client) throw new TypeError("Catalog-backed MCP requires an authenticated backend client.");
  const client = options.client;
  let observedRevision = null;
  let revisionCheckRunning = false;
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
    observedRevision = result.revision ?? observedRevision;
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
  const checkRevision = async () => {
    if (revisionCheckRunning) return;
    revisionCheckRunning = true;
    try {
      const result = await client.get("/internal/session/tool/catalog/revision");
      const next = result.revision ?? null;
      if (observedRevision != null && next != null && next !== observedRevision) {
        observedRevision = next;
        await server.sendToolListChanged();
      } else if (observedRevision == null) {
        observedRevision = next;
      }
    } catch {
      // The authenticated backend can be briefly unavailable during a local
      // restart. The next poll retries without terminating the MCP transport.
    } finally {
      revisionCheckRunning = false;
    }
  };
  const unsubscribe = typeof client.subscribeCatalogChanges === "function"
    ? client.subscribeCatalogChanges(checkRevision)
    : null;
  const pollIntervalMs = Number(options.pollIntervalMs ?? (unsubscribe ? 0 : 1_000));
  const revisionTimer = pollIntervalMs > 0 ? setInterval(checkRevision, pollIntervalMs) : null;
  revisionTimer?.unref?.();
  // Close the small race between the initial tools/list and event subscription.
  if (unsubscribe) queueMicrotask(checkRevision);
  if (revisionTimer || unsubscribe) server.onclose = () => {
    if (revisionTimer) clearInterval(revisionTimer);
    unsubscribe?.();
  };
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
