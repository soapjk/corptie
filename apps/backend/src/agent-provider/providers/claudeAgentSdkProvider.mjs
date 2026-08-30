import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";

export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-sdk";
export const CLAUDE_TOOL_SCHEMA_CAPABILITIES = Object.freeze({
  bootstrapAttach: false,
  appendInPlace: false,
  replaceAtTurnBoundary: false,
  generatedMcpRefresh: true,
  restrictedGateway: false,
  bindingReplacement: false,
  capabilityRevision: "claude-sdk:catalog-mcp:3"
});
const CORPTIE_OWNED_CLAUDE_WORKSPACE_TOOLS = Object.freeze([
  "EnterWorktree",
  "ExitWorktree"
]);

export function createClaudeAgentSdkProvider(manager, options = {}) {
  if (!manager) throw new TypeError("Claude Agent SDK Provider requires a manager.");
  return new CallbackAgentProvider({
    id: CLAUDE_AGENT_SDK_PROVIDER_ID,
    displayName: "Claude Code",
    transport: "agent-sdk",
    aliases: ["claude", "claude-code", "claude_code"],
    runtime: { lifecycle: "managed" },
    metadata: {
      backgroundPermissionProfiles: ["read-only"],
      toolSchemaCapabilities: CLAUDE_TOOL_SCHEMA_CAPABILITIES,
      sessionRecovery: {
        revision: "claude-sdk:session-recovery:1",
        capabilities: [
          "explicit_replay", "system_context_injection", "tool_result_history", "max_context_estimation"
        ],
        maxContextTokens: 200_000
      }
    },
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_CLEAR,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
      ...(typeof options.listModels === "function" ? [AGENT_PROVIDER_CAPABILITIES.MODEL_LIST] : []),
      AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
      AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE,
      ...(typeof options.prepareWorkspaceTransition === "function"
        ? [AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION]
        : []),
      ...(typeof options.bindWorkspace === "function" && typeof options.inspectWorkspaceBinding === "function"
        ? [AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND]
        : []),
      ...(typeof options.attachTools === "function"
        ? [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH]
        : []),
      AGENT_PROVIDER_CAPABILITIES.SKILL_LAZY_LOAD,
      AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES,
      AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT
    ]
  }, {
    ...(typeof options.prepareSessionInput === "function"
      ? { prepareSessionInput: options.prepareSessionInput }
      : {}),
    createSession: (input) => manager.start(input),
    resumeSession: (reference, context = {}) => manager.reconnect(reference.providerSessionId, {
      runtimeOptions: context.toolHost?.providerAttachment
    }),
    deleteSession: (reference) => manager.delete(reference.providerSessionId),
    renameSession: (reference, title) => manager.rename(reference.providerSessionId, title),
    send: (reference, message, context = {}) => manager.send(reference.providerSessionId, message, {
      ...(context.source && typeof context.source === "object" ? context.source : {}),
      contextPrompt: context.sessionContext?.prompt ?? null,
      turnId: context.idempotencyKey ?? null,
      localVisibility: "status_only"
    }),
    clearConversation: (reference) => manager.clear(reference.providerSessionId),
    interrupt: (reference) => manager.interrupt(reference.providerSessionId),
    respondToApproval: (reference, approval) => manager.respondToChoice(reference.providerSessionId, approval),
    ...(typeof options.listModels === "function" ? { listModels: options.listModels } : {}),
    switchModel: (reference, modelId) => manager.switchModel(reference.providerSessionId, modelId),
    updatePermissions: (reference, permissions) => manager.updatePermissions(reference.providerSessionId, permissions),
    ...(typeof options.prepareWorkspaceTransition === "function"
      ? { prepareWorkspaceTransition: options.prepareWorkspaceTransition }
      : {}),
    ...(typeof options.bindWorkspace === "function" ? { bindWorkspace: options.bindWorkspace } : {}),
    ...(typeof options.inspectWorkspaceBinding === "function"
      ? { inspectWorkspaceBinding: options.inspectWorkspaceBinding }
      : {}),
    ...(typeof options.attachTools === "function"
      ? { attachTools: options.attachTools }
      : {}),
    readAccountUsage: (reference) => manager.readAccountUsage(reference.providerSessionId),
    readSessionUsage: (reference) => manager.readSessionUsage(reference.providerSessionId),
    runBackgroundPrompt: (input) => manager.runBackgroundPrompt(input),
    probeToolSchemaCapabilities: options.probeToolSchemaCapabilities
      ?? (() => CLAUDE_TOOL_SCHEMA_CAPABILITIES),
    ...(typeof options.applyToolPlanAtTurnBoundary === "function"
      ? { applyToolPlanAtTurnBoundary: options.applyToolPlanAtTurnBoundary }
      : {})
  });
}

export function claudeToolHostAttachment(attachment, providerOptions = {}) {
  if (!attachment?.actorId || !Array.isArray(attachment?.tools)) {
    throw new TypeError("Claude Tool Host attachment requires an actor id and tool catalog.");
  }
  const skillMcpServers = Object.fromEntries(Object.entries(attachment.mcpServers ?? {}).map(([name, server]) => [
    name,
    { type: server.type ?? (server.url ? "http" : "stdio"), ...server }
  ]));
  const configuredMcpServers = providerOptions.mcpServers ?? {};
  const conflict = Object.keys(skillMcpServers)
    .find((name) => Object.prototype.hasOwnProperty.call(configuredMcpServers, name));
  if (conflict) {
    const error = new Error(`MCP server name conflicts with an existing Provider server: ${conflict}`);
    error.code = "MCP_SERVER_NAME_CONFLICT";
    throw error;
  }
  return {
    actorId: attachment.actorId,
    mcpServers: { ...configuredMcpServers, ...skillMcpServers },
    plugins: Array.isArray(providerOptions.plugins)
      ? providerOptions.plugins.map((plugin) => ({ ...plugin }))
      : [],
    skills: providerOptions.skills ?? "all",
    settingSources: providerOptions.settingSources ?? ["user", "project", "local"],
    systemPrompt: providerOptions.systemPrompt ?? undefined,
    disallowedTools: [
      ...new Set([
        ...CORPTIE_OWNED_CLAUDE_WORKSPACE_TOOLS,
        ...(Array.isArray(providerOptions.disallowedTools) ? providerOptions.disallowedTools : [])
      ])
    ]
  };
}
