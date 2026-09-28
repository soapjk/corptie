export function claudePermissionMode(sandbox = "workspace-write", approvalPolicy = "on-request") {
  if (approvalPolicy === "never" && sandbox === "danger-full-access") {
    return "bypassPermissions";
  }
  if (approvalPolicy === "never") {
    return "dontAsk";
  }
  return "default";
}

export function claudePermissionOptions(session) {
  const permissionMode = session.permissionMode ?? claudePermissionMode(session.sandbox, session.approvalPolicy);
  return {
    permissionMode,
    // This flag only permits a later explicit switch to bypass mode; the
    // active permissionMode remains authoritative and is not widened by it.
    allowDangerouslySkipPermissions: true
  };
}

// Claude effort levels mirror the Agent SDK's EffortLevel union. "off" is not
// part of the SDK surface; callers map a disabled level to undefined before it
// reaches this helper.
export function normalizeClaudeEffortLevel(value) {
  const level = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["low", "medium", "high", "xhigh", "max"].includes(level) ? level : null;
}

export function normalizeClaudeRuntimeOptions(input = {}) {
  if (!input || typeof input !== "object") return {};
  const result = {};
  if (Object.hasOwn(input, "tools")) {
    // Empty is meaningful: the SDK disables every builtin. Never discard a
    // restrictive list or normalize invalid input into the SDK's default set.
    if (!Array.isArray(input.tools) || input.tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
      throw new TypeError("Claude runtime tools must be an explicit array of tool names.");
    }
    result.tools = [...new Set(input.tools.map((tool) => tool.trim()))];
  }
  if (input.mcpServers && typeof input.mcpServers === "object") {
    result.mcpServers = { ...input.mcpServers };
  }
  if (Array.isArray(input.plugins)) {
    result.plugins = input.plugins.map((plugin) => ({ ...plugin }));
  }
  if (input.skills === "all" || Array.isArray(input.skills)) {
    result.skills = Array.isArray(input.skills) ? [...input.skills] : input.skills;
  }
  if (Array.isArray(input.settingSources)) {
    result.settingSources = [...input.settingSources];
  }
  if (Array.isArray(input.additionalDirectories)) {
    result.additionalDirectories = [...new Set(input.additionalDirectories.filter((path) => (
      typeof path === "string" && path.trim()
    )).map((path) => path.trim()))];
  }
  if (Array.isArray(input.disallowedTools)) {
    result.disallowedTools = [...new Set(input.disallowedTools.filter((tool) => {
      return typeof tool === "string" && tool.trim();
    }).map((tool) => tool.trim()))];
  }
  if (typeof input.systemPrompt === "string" || Array.isArray(input.systemPrompt) || input.systemPrompt?.type === "preset") {
    result.systemPrompt = input.systemPrompt;
  }
  return result;
}
