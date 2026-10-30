const text = { type: "string", minLength: 1 };
const source = {
  sourceType: { type: "string", enum: ["local", "git", "url"] }, source: text
};
const mcp = {
  name: text,
  transport: { type: "string", enum: ["http", "streamable-http", "sse", "stdio"] },
  url: text, command: text, cwd: text,
  args: { type: "array", maxItems: 32, items: { type: "string" } },
  installRequestId: { type: "string", format: "uuid" }
};
function tool(name, description, properties, required = []) {
  return { name, type: "function", deferLoading: false, description,
    inputSchema: { type: "object", additionalProperties: false, properties, required } };
}
export const integrationRegistryDynamicTools = Object.freeze([
  tool("corptie_integration_list", "List registered MCP Servers and Skills in Corptie. Registration does not assign a resource to an Agent or make it callable in a Session.", {}),
  tool("corptie_mcp_register", "Register and verify an independent MCP Server in Corptie when the user requests installation. Use http (or streamable-http) for Streamable HTTP. For stdio, command and cwd must be absolute paths. Protocol headers are negotiated automatically. Do not put secrets in tool arguments; credentialed installations use the native MCP management UI. Returns the saved Server and its observed tools; does not assign it to any Agent. Reuse installRequestId for retries.", mcp, ["name", "transport"]),
  tool("corptie_skill_discover", "Inspect a local directory, Git repository or public HTTPS ZIP URL for installable Skill packages before registration. URL sources must not contain credentials or query tokens. Returns candidates and sourceSubpath; does not install or assign a Skill.", source, ["sourceType", "source"]),
  tool("corptie_skill_install_preview", "Check the selected Skill source for existing installations before installing. Does not register, update, merge or assign. An existing source requires an explicit update; manifest equality does not establish package version equality.", {
    ...source, sourceSubpath: { type: "string" }
  }, ["sourceType", "source"]),
  tool("corptie_skill_duplicates_list", "List same-source duplicate Skill registrations. Read-only; never merge or remove installations without explicit user confirmation.", {}),
  tool("corptie_skill_install_operation_get", "Inspect a persisted Skill installation operation. An interrupted or repair_required operation must not be retried under a new request ID to bypass recovery.", { operationId: text }, ["operationId"]),
  tool("corptie_skill_install_operation_recover", "Repair an interrupted Skill activation only on an explicit user recovery request. Restores the committed managed package across configured Provider runtimes; never downloads a new version or changes assignments. Requires idle Sessions.", { operationId: text }, ["operationId"]),
  tool("corptie_skill_update", "Update one exact registered Skill only when the user requests an update. Preserves its Skill ID and Agent assignments. Do not use as an automatic fallback from a duplicate installation error.", {
    skillId: text, ...source, name: text, description: { type: "string" }, sourceSubpath: { type: "string" }, requestId: text, async: { type: "boolean", description: "Return an operation receipt immediately; poll corptie_skill_install_operation_get for completion." }
  }, ["skillId"]),
  tool("corptie_skill_register", "Install a complete Skill package into Corptie-managed storage from a local directory, Git repository or public HTTPS ZIP URL when the user requests installation. Use sourceSubpath from discovery for multiple candidates. Prefer async=true for remote sources and reuse requestId on retry; query the returned operationId until terminal. Bundled MCP descriptors are handled by the existing Skill installer. Does not assign the Skill to any Agent.", {
    ...source, name: text, description: { type: "string" }, sourceSubpath: { type: "string" }, requestId: text, async: { type: "boolean" }
  }, ["sourceType", "source"])
]);

export async function callIntegrationRegistryDynamicTool({ mcpRegistryService, skillRegistryService, onChanged }, input) {
  if (!input.metadata?.sessionId || !input.actorId) {
    throw Object.assign(new Error("Registration tools require an authenticated Session."), { code: "SESSION_AUTHENTICATION_REQUIRED" });
  }
  const definition = integrationRegistryDynamicTools.find((entry) => entry.name === input.tool);
  if (!definition) throw Object.assign(new Error("Unsupported registration tool."), { code: "HOST_TOOL_UNSUPPORTED" });
  const args = input.arguments ?? {};
  const schema = definition.inputSchema;
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))
    || schema.required.some((key) => typeof args[key] !== "string" || !args[key].trim())
    || (args.sourceType != null && !["local", "git", "url"].includes(args.sourceType))
    || (args.async != null && typeof args.async !== "boolean")) {
    throw Object.assign(new Error("Invalid registration arguments; secrets must be configured through the native UI."), { code: "INVALID_INPUT" });
  }
  switch (input.tool) {
    case "corptie_integration_list":
      return { servers: mcpRegistryService.list(), skills: skillRegistryService.list() };
    case "corptie_mcp_register": {
      const server = await mcpRegistryService.register({ ...args,
        transport: args.transport === "streamable-http" ? "http" : args.transport });
      if (!server.idempotentReplay) onChanged?.("McpServerChanged", { action: "created", entity: server });
      return { server, assigned: false };
    }
    case "corptie_skill_discover":
      return skillRegistryService.discover({ ...args, assist: false });
    case "corptie_skill_install_preview":
      return skillRegistryService.previewInstall(args);
    case "corptie_skill_duplicates_list":
      return skillRegistryService.duplicates();
    case "corptie_skill_install_operation_get":
      return skillRegistryService.installationOperation(args.operationId);
    case "corptie_skill_install_operation_recover": {
      const operation = await skillRegistryService.recoverInstallation(args.operationId);
      onChanged?.("SkillChanged", { action: "recovered", entity: { skillId: operation.skillId } });
      return { operation };
    }
    case "corptie_skill_update": {
      const { skillId, ...changes } = args;
      if (args.async === true) return { operation: skillRegistryService.submitInstallation({ ...changes, assist: false }, {
        skillId, onCompleted: (skill) => onChanged?.("SkillChanged", { action: "updated", entity: skill })
      }), assignmentsPreserved: true };
      const skill = await skillRegistryService.update(skillId, { ...changes, assist: false });
      if (!skill.idempotentReplay) onChanged?.("SkillChanged", { action: "updated", entity: skill });
      return { skill, assignmentsPreserved: true };
    }
    case "corptie_skill_register": {
      if (args.async === true) return { operation: skillRegistryService.submitInstallation({ ...args, assist: false }, {
        onCompleted: (skill) => onChanged?.("SkillChanged", { action: "created", entity: skill })
      }), assigned: false };
      const skill = await skillRegistryService.register({ ...args, assist: false });
      if (!skill.idempotentReplay) onChanged?.("SkillChanged", { action: "created", entity: skill });
      return { skill, assigned: false };
    }
  }
}
