// Local management surface for independently installed MCP Servers.
export async function handleMcpRegistryHttpRequest({ request, response, url, service, onChanged }) {
  const path = url.pathname;
  if (path !== "/mcp-servers" && !path.startsWith("/mcp-servers/")
    && !/^\/agents\/[^/]+\/mcp-servers(?:\/[^/]+)?$/.test(path)) return false;
  try {
    if (path === "/mcp-servers" && request.method === "GET") {
      return send(response, 200, { servers: service.list() });
    }
    if (path === "/mcp-servers/verify" && request.method === "POST") {
      return send(response, 200, { verification: await service.verify(await readBody(request)) });
    }
    if (path === "/mcp-servers" && request.method === "POST") {
      const server = await service.register(await readBody(request));
      onChanged?.("McpServerChanged", { action: "created", entity: server });
      return send(response, 201, { server });
    }
    const agentMatch = /^\/agents\/([^/]+)\/mcp-servers(?:\/([^/]+))?$/.exec(path);
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      if (!agentMatch[2] && request.method === "GET") {
        return send(response, 200, { serverIds: service.listForAgent(agentId) });
      }
      if (agentMatch[2] && ["PUT", "DELETE"].includes(request.method)) {
        const assignment = service.setAssignment(agentId, decodeURIComponent(agentMatch[2]), request.method === "PUT");
        onChanged?.("McpAssignmentChanged", { action: request.method === "PUT" ? "assigned" : "unassigned", entity: assignment });
        return send(response, 200, { assignment });
      }
    }
    const serverMatch = /^\/mcp-servers\/([^/]+)$/.exec(path);
    if (serverMatch) {
      const serverId = decodeURIComponent(serverMatch[1]);
      if (request.method === "GET") {
        const server = service.get(serverId);
        return server ? send(response, 200, { server })
          : send(response, 404, { code: "MCP_SERVER_NOT_FOUND", error: "MCP Server not found." });
      }
      if (request.method === "PATCH") {
        const body = await readBody(request);
        const server = service.setEnabled(serverId, body.enabled);
        onChanged?.("McpServerChanged", { action: server.enabled ? "enabled" : "disabled", entity: server });
        return send(response, 200, { server });
      }
      if (request.method === "DELETE") {
        const result = service.remove(serverId);
        onChanged?.("McpServerChanged", { action: "removed", entity: result });
        return send(response, 200, result);
      }
    }
    return send(response, 405, { code: "METHOD_NOT_ALLOWED", error: "Unsupported MCP management operation." });
  } catch (error) {
    return send(response, error.statusCode ?? 500, {
      code: error.code ?? "MCP_MANAGEMENT_FAILED",
      error: error.code ? error.message : "MCP management operation failed."
    });
  }
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) {
      const error = new Error("MCP request body is too large.");
      error.code = "REQUEST_TOO_LARGE";
      error.statusCode = 413;
      throw error;
    }
  }
  try { return JSON.parse(body); } catch {
    const error = new Error("Invalid JSON body.");
    error.code = "INVALID_JSON";
    error.statusCode = 400;
    throw error;
  }
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
  return true;
}
