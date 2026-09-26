export function skillMcpTurnContext(assignmentRevision) {
  const revision = typeof assignmentRevision === "string" ? assignmentRevision.trim() : "";
  if (!revision || revision === "none") return null;
  return Object.freeze({
    prompt: `<corptie_skill_mcp_routing revision="${revision}">
Assigned MCP tools, including Skill dependencies and standalone Servers, can be hot-routed through the fixed Corptie Tool Host even when native tools are absent from this Provider thread. Before declaring an assigned MCP tool unavailable, call corptie_tool_catalog_search with the Server or required tool name. If it returns an mcp or skill-mcp domain, use its invocation contract and call the canonical tool through corptie_tool_call. A returned gateway contract counts as an available authenticated capability; no new Session or Provider binding replacement is required.
</corptie_skill_mcp_routing>`
  });
}
