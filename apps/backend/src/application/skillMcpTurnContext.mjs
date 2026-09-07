export function skillMcpTurnContext(assignmentRevision) {
  const revision = typeof assignmentRevision === "string" ? assignmentRevision.trim() : "";
  if (!revision || revision === "none") return null;
  return Object.freeze({
    prompt: `<corptie_skill_mcp_routing revision="${revision}">
Assigned Skill MCP tools can be hot-routed through the fixed Corptie Tool Host even when same-named native tools are absent from this Provider thread. Before declaring a Skill's MCP injection unavailable, you must call corptie_tool_catalog_search with the Skill or required tool name. If it returns a skill-mcp domain, use its invocation contract and call the canonical tool through corptie_tool_call. A returned gateway contract counts as an available authenticated Skill capability; no new Session or Provider binding replacement is required.
</corptie_skill_mcp_routing>`
  });
}
