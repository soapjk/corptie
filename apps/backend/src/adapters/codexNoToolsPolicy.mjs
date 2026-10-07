export function codexNoToolsConfig(mcpServers = {}) {
  return {
    "features.apps": false, "features.shell_tool": false, "features.unified_exec": false,
    "features.multi_agent": false, "features.js_repl": false,
    "features.code_mode.enabled": false, "features.token_budget": false,
    "features.goals": false,
    "features.current_time_reminder": false,
    "tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
    "tools.view_image": false, web_search: "disabled",
    "orchestrator.skills.enabled": false, "orchestrator.mcp.enabled": false,
    mcp_servers: Object.fromEntries(Object.entries(mcpServers).map(([name, server]) =>
      [name, { ...(typeof server.url === "string" ? { url: server.url } :
        typeof server.command === "string" ? { command: server.command } : {}), enabled: false }])),
    "memories.generate_memories": false, "memories.use_memories": false
  };
}
