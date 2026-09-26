// Local management surface for independently installed MCP Servers.
export async function handleMcpRegistryHttpRequest({ request, response, url, service, availabilityService, onChanged }) {
  const path = url.pathname;
  const sessionAvailabilityMatch = /^\/sessions\/([^/]+)\/mcp-availability$/.exec(path);
  if (path !== "/mcp-servers" && !path.startsWith("/mcp-servers/")
    && !/^\/agents\/[^/]+\/mcp-servers(?:\/[^/]+)?$/.test(path)
    && !sessionAvailabilityMatch && path !== "/mcp-availability") return false;
  try {
    // The management API is for the native local client. A browser Origin
    // must not be able to install executable MCP packages or bind credentials.
    if (request.headers?.origin) {
      return send(response, 403, { code: "MCP_BROWSER_ORIGIN_FORBIDDEN",
        error: "MCP management is available only to the native local client." });
    }
    if (path === "/mcp-availability" && request.method === "GET") {
      const reference = url.searchParams.get("session")?.trim();
      if (!reference) return send(response, 400, { code: "INVALID_INPUT", error: "Session name or id is required." });
      return send(response, 200, { availability: await availabilityService.inspect(reference) });
    }
    if (sessionAvailabilityMatch && request.method === "GET") {
      return send(response, 200, { availability: await availabilityService.inspect(
        decodeURIComponent(sessionAvailabilityMatch[1])) });
    }
    if (path === "/mcp-servers" && request.method === "GET") {
      return send(response, 200, { servers: service.list() });
    }
    if (path === "/mcp-servers/verify" && request.method === "POST") {
      return send(response, 200, { verification: await service.verify(await readBody(request)) });
    }
    if (path === "/mcp-servers/discover" && request.method === "POST") {
      return send(response, 200, { discovery: await service.discoverPackage(await readBody(request)) });
    }
    if (path === "/mcp-servers/package" && request.method === "POST") {
      const server = await service.registerPackage(await readBody(request));
      if (!server.idempotentReplay) onChanged?.("McpServerChanged", { action: "created", entity: server });
      return send(response, server.idempotentReplay ? 200 : 201, { server });
    }
    if (path === "/mcp-servers" && request.method === "POST") {
      const server = await service.register(await readBody(request));
      if (!server.idempotentReplay) onChanged?.("McpServerChanged", { action: "created", entity: server });
      return send(response, server.idempotentReplay ? 200 : 201, { server });
    }
    const verifyInstalledMatch = /^\/mcp-servers\/([^/]+)\/verify$/.exec(path);
    if (verifyInstalledMatch && request.method === "POST") {
      const server = await service.checkInstallation(decodeURIComponent(verifyInstalledMatch[1]));
      onChanged?.("McpServerChanged", { action: "checked", entity: server });
      return send(response, 200, { server });
    }
    const packageVersionsMatch = /^\/mcp-servers\/([^/]+)\/versions$/.exec(path);
    if (packageVersionsMatch && request.method === "GET") {
      return send(response, 200, { versions: service.listPackageVersions(decodeURIComponent(packageVersionsMatch[1])) });
    }
    const packageUpdateMatch = /^\/mcp-servers\/([^/]+)\/package$/.exec(path);
    if (packageUpdateMatch && request.method === "POST") {
      const server = await service.updatePackage(decodeURIComponent(packageUpdateMatch[1]), await readBody(request));
      onChanged?.("McpServerChanged", { action: "updated", entity: server });
      return send(response, 200, { server });
    }
    const packageRollbackMatch = /^\/mcp-servers\/([^/]+)\/rollback$/.exec(path);
    if (packageRollbackMatch && request.method === "POST") {
      const server = await service.rollbackPackage(decodeURIComponent(packageRollbackMatch[1]), await readBody(request));
      onChanged?.("McpServerChanged", { action: "rolled_back", entity: server });
      return send(response, 200, { server });
    }
    const deletionImpactMatch = /^\/mcp-servers\/([^/]+)\/deletion-impact$/.exec(path);
    if (deletionImpactMatch && request.method === "GET") {
      return send(response, 200, {
        impact: service.deletionImpact(decodeURIComponent(deletionImpactMatch[1]))
      });
    }
    const runtimeEventsMatch = /^\/mcp-servers\/([^/]+)\/runtime-events$/.exec(path);
    if (runtimeEventsMatch && request.method === "GET") {
      return send(response, 200, {
        events: service.runtimeEvents(decodeURIComponent(runtimeEventsMatch[1]),
          Number(url.searchParams.get("limit") ?? 50))
      });
    }
    const agentMatch = /^\/agents\/([^/]+)\/mcp-servers(?:\/([^/]+))?$/.exec(path);
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      if (!agentMatch[2] && request.method === "GET") {
        return send(response, 200, { serverIds: service.listForAgent(agentId),
          assignments: service.assignmentDetailsForAgent(agentId) });
      }
      if (agentMatch[2] && ["PUT", "DELETE"].includes(request.method)) {
        const assignment = service.setAssignment(agentId, decodeURIComponent(agentMatch[2]),
          request.method === "PUT", request.method === "PUT" ? await readBody(request, { allowEmpty: true }) : {});
        if (assignment.changed !== false) onChanged?.("McpAssignmentChanged", {
          action: request.method === "PUT" ? "assigned" : "unassigned", entity: assignment
        });
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
        const enableOnly = body && typeof body === "object" && !Array.isArray(body)
          && Object.keys(body).length === 1 && Object.hasOwn(body, "enabled");
        const server = enableOnly
          ? service.setEnabled(serverId, body.enabled)
          : await service.updateConfig(serverId, body);
        if (!server.idempotentReplay) onChanged?.("McpServerChanged", {
          action: enableOnly ? (server.enabled ? "enabled" : "disabled") : "updated", entity: server
        });
        return send(response, 200, { server });
      }
      if (request.method === "DELETE") {
        const result = await service.remove(serverId);
        if (result.removed) onChanged?.("McpServerChanged", { action: "removed", entity: result });
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

async function readBody(request, { allowEmpty = false } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) {
      const error = new Error("MCP request body is too large.");
      error.code = "REQUEST_TOO_LARGE";
      error.statusCode = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  if (allowEmpty && size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch {
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
