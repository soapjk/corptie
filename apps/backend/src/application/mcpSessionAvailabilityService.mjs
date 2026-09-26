// Read-only diagnostic for one exact Session route. It never invokes a remote
// tool or changes the Provider binding; it inspects the fixed gateway that the
// Session's current Agent and Provider would use on its next turn.
export class McpSessionAvailabilityService {
  constructor({ store, gateway, registry } = {}) {
    if (!store || !gateway) throw new TypeError("MCP Session availability requires store and gateway.");
    this.store = store;
    this.gateway = gateway;
    this.registry = registry;
  }

  async inspect(sessionReference) {
    const logical = sessionReference.startsWith("logical:")
      ? this.store.getLogicalSession(sessionReference)
      : this.store.getLogicalSessionByName(sessionReference);
    if (!logical) throw availabilityError("SESSION_NOT_FOUND", "Session not found.", 404);
    const binding = logical.activeBinding;
    const session = logical.legacySessionId ? this.store.getSession(logical.legacySessionId) : null;
    const agentId = session?.agentId ?? null;
    const base = {
      logicalSessionId: logical.logicalSessionId,
      sessionName: logical.sessionName,
      bindingId: binding?.bindingId ?? null,
      providerId: binding?.providerId ?? null,
      agentId,
      toolHostStatus: binding?.bindingId
        ? this.store.getSessionToolCatalogMaterialization(logical.logicalSessionId, binding.bindingId)?.status ?? "unknown"
        : "unknown"
    };
    if (!binding || binding.state !== "active") {
      return { ...base, status: "no_active_binding", errorCode: "MCP_SESSION_BINDING_INACTIVE", servers: [] };
    }
    if (!agentId || !this.store.getAgent(agentId)) {
      return { ...base, status: "agent_unavailable", errorCode: "MCP_SESSION_AGENT_UNAVAILABLE", servers: [] };
    }
    const declaredSkills = (this.store.listRegistrySkillsForAgent?.(agentId) ?? [])
      .filter((skill) => skill.mcpDescriptorSubpath)
      .map((skill) => ({ skillId: skill.skillId, name: skill.name }));
    const standaloneAssignments = (this.registry?.listForAgent(agentId) ?? [])
      .map((serverId) => this.registry.get(serverId))
      .filter(Boolean)
      .map((server) => ({ serverId: server.serverId, name: server.name,
        enabled: server.enabled, lastCheckStatus: server.lastCheckStatus,
        lastErrorCode: server.lastErrorCode,
        lastToolsList: this.registry?.latestRuntimeEvent?.(server.serverId, "tools-list") ?? null,
        lastSessionCall: this.registry?.latestRuntimeEvent?.(
          server.serverId, "tool-call", logical.logicalSessionId) ?? null }));
    try {
      const result = await this.gateway.availability({
        actorId: agentId,
        providerId: binding.providerId,
        metadata: { logicalSessionId: logical.logicalSessionId, bindingId: binding.bindingId }
      });
      const noServers = result.servers.length === 0;
      const assignedButUnresolved = noServers && (declaredSkills.length > 0 || standaloneAssignments.length > 0);
      const noAuthorizedTools = !noServers && result.servers.every((server) =>
        server.available && server.toolNames.length === 0);
      const status = assignedButUnresolved ? "assigned_mcp_unresolved"
        : noServers ? "no_mcp_assigned"
          : noAuthorizedTools ? "no_tools_allowed"
          : result.servers.some((server) => !server.available) ? "degraded"
            : base.toolHostStatus === "applied" ? "available" : "gateway_available_host_unverified";
      return { ...base,
        status,
        errorCode: assignedButUnresolved ? "MCP_ASSIGNED_SERVER_UNRESOLVED"
          : status === "gateway_available_host_unverified" ? "MCP_TOOL_HOST_UNVERIFIED" : null,
        catalogVersion: result.catalogVersion,
        declaredSkills, standaloneAssignments, servers: result.servers
      };
    } catch (error) {
      return { ...base, status: "gateway_unavailable",
        errorCode: typeof error?.code === "string" && /^MCP_/.test(error.code)
          ? error.code : "MCP_DIAGNOSTIC_FAILED",
        declaredSkills, standaloneAssignments, servers: [] };
    }
  }
}

function availabilityError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
