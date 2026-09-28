import { collaborationRuntimeInstructions } from "../application/collaborationRuntimeInstructions.mjs";
import { collaborationMcpEnvironment, collaborationMcpServerName } from "../utils/collaborationRuntime.mjs";

// Adapter-specific startup instructions and MCP attachment shapes. Tool catalogs
// remain owned by ToolHostService; this factory does not materialize any tools.
export function createCollaborationProviderOptions({
  agentContextService, corptieClaudeRuntimePaths,
  collaborationMcpServerPath, port, environmentName
}) {
  function collaborationThreadOptions(agentId, metadata = null) {
    if (!agentId) return {};
    // Tool definitions are attached only through ToolHostService after a
    // capability probe. This fallback carries runtime instructions but never
    // recreates an eager, Provider-specific catalog.
    return collaborationProviderRuntimeOptions(agentId, metadata);
  }

  // 会话创建专用：在静态协作协议基础上，追加 Agent 身份 + systemPrompt + per-agent 记忆。
  async function collaborationThreadOptionsWithAgentContext(agentId, metadata = null) {
    const base = collaborationThreadOptions(agentId, metadata);
    if (!agentId) return base;
    const agentContext = await collaborationAgentContextInstructions(agentId, metadata);
    if (!agentContext) return base;
    const developerInstructions = [agentContext, base.developerInstructions].filter(Boolean).join("\n\n");
    return { ...base, developerInstructions };
  }

  async function collaborationProviderRuntimeOptionsWithAgentContext(agentId, metadata = null) {
    const base = collaborationProviderRuntimeOptions(agentId, metadata);
    if (!agentId) return base;
    const agentContext = await collaborationAgentContextInstructions(agentId, metadata);
    if (!agentContext) return base;
    const developerInstructions = [agentContext, base.developerInstructions].filter(Boolean).join("\n\n");
    return { ...base, developerInstructions };
  }

  // Agent 上下文（systemPrompt + description + per-agent 记忆），异步组装。
  // 仅用于会话创建时注入 Agent 身份；resume / workspace 切换沿用静态协议指令。
  async function collaborationAgentContextInstructions(agentId, metadata = null) {
    if (!agentId) return "";
    const context = await agentContextService.buildAgentContext(agentId, {
      intent: "",
      scope: {
        sessionId: metadata?.sessionId ?? null,
        workId: metadata?.workId ?? null,
        taskId: metadata?.taskId ?? null
      }
    });
    return context?.instructions ?? "";
  }

  function collaborationProviderRuntimeOptions(agentId, metadata = null) {
    const authenticatedMcpServers = metadata?.sessionId
      ? {
          [collaborationMcpServerName(agentId)]: {
            ...collaborationMcpProcessOptions(agentId, metadata),
            startup_timeout_sec: 5,
            required: false
          }
        }
      : {};
    return {
      config: {
        features: {
          multi_agent: false
        },
        mcp_servers: authenticatedMcpServers
      },
      developerInstructions: collaborationRuntimeInstructions(agentId, metadata)
    };
  }

  function claudeCollaborationRuntimeOptions(agentId, metadata = null) {
    const authenticatedMcpServers = metadata?.sessionId
      ? {
          [collaborationMcpServerName(agentId)]: {
            type: "stdio",
            ...collaborationMcpProcessOptions(agentId, metadata),
            timeout: 5_000,
            alwaysLoad: true
          }
        }
      : {};
    return {
      mcpServers: authenticatedMcpServers,
      plugins: [{
        type: "local",
        path: corptieClaudeRuntimePaths.pluginPath,
        skipMcpDiscovery: true
      }],
      skills: "all",
      settingSources: ["user", "project", "local"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: collaborationRuntimeInstructions(agentId, metadata)
      }
    };
  }

  // 会话创建专用：在静态协作协议基础上，追加 Agent 身份 + systemPrompt + per-agent 记忆。
  async function claudeCollaborationRuntimeOptionsWithAgentContext(agentId, metadata = null) {
    const base = claudeCollaborationRuntimeOptions(agentId, metadata);
    if (!agentId) return base;
    const agentContext = await collaborationAgentContextInstructions(agentId, metadata);
    if (!agentContext) return base;
    const append = [agentContext, collaborationRuntimeInstructions(agentId, metadata)].filter(Boolean).join("\n\n");
    return {
      ...base,
      systemPrompt: { ...base.systemPrompt, append }
    };
  }

  function collaborationMcpProcessOptions(agentId, metadata = null) {
    return {
      command: process.execPath,
      args: [collaborationMcpServerPath],
      env: collaborationMcpEnvironment({
        agentId,
        backendUrl: `http://127.0.0.1:${port}`,
        environmentName,
        metadata
      })
    };
  }
  return {
    collaborationThreadOptionsWithAgentContext, collaborationProviderRuntimeOptionsWithAgentContext,
    claudeCollaborationRuntimeOptionsWithAgentContext, collaborationAgentContextInstructions
  };
}
