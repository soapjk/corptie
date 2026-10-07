const text = { type: "string", minLength: 1 };
const source = {
  sourceType: { type: "string", enum: ["local", "git"] }, source: text
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
  tool("corptie_skill_discover", "Inspect a local directory or Git repository for installable Skill packages before registration. Returns candidates and sourceSubpath; does not install or assign a Skill.", source, ["sourceType", "source"]),
  tool("corptie_skill_register", "Register and materialize a Skill from a local directory or Git repository when the user requests installation. Use sourceSubpath from discovery for a multi-Skill repository. Bundled MCP descriptors are handled by the existing Skill installer. Does not assign the Skill to any Agent.", {
    ...source, name: text, description: { type: "string" }, sourceSubpath: { type: "string" }
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
    || (args.sourceType != null && !["local", "git"].includes(args.sourceType))) {
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
    case "corptie_skill_register": {
      const skill = await skillRegistryService.register({ ...args, assist: false });
      onChanged?.("SkillChanged", { action: "created", entity: skill });
      return { skill, assigned: false };
    }
  }
}
