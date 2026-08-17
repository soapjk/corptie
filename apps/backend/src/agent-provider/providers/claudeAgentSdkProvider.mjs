import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";

export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-sdk";
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
    metadata: { backgroundPermissionProfiles: ["read-only"] },
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
      ...(typeof options.attachTools === "function"
        ? [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH]
        : []),
      ...(typeof options.attachTools === "function"
        ? [AGENT_PROVIDER_CAPABILITIES.SKILL_LAZY_LOAD]
        : []),
      AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT
    ]
  }, {
    ...(typeof options.prepareSessionInput === "function"
      ? { prepareSessionInput: options.prepareSessionInput }
      : {}),
    listSessions: (options) => manager.list(options),
    readSession: (reference) => manager.read(reference.providerSessionId),
    createSession: (input) => manager.start(input),
    resumeSession: (reference) => manager.reconnect(reference.providerSessionId),
    deleteSession: (reference) => manager.delete(reference.providerSessionId),
    renameSession: (reference, title) => manager.rename(reference.providerSessionId, title),
    send: (reference, message, context = {}) => manager.send(reference.providerSessionId, message, {
      ...(context.source && typeof context.source === "object" ? context.source : {}),
      contextPrompt: context.sessionContext?.prompt ?? null
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
    ...(typeof options.attachTools === "function"
      ? { attachTools: options.attachTools }
      : {}),
    readAccountUsage: (reference) => manager.readAccountUsage(reference.providerSessionId),
    readSessionUsage: (reference) => manager.readSessionUsage(reference.providerSessionId),
    runBackgroundPrompt: (input) => manager.runBackgroundPrompt(input)
  });
}

export function claudeToolHostAttachment(attachment, providerOptions = {}) {
  if (!attachment?.actorId || !Array.isArray(attachment?.tools)) {
    throw new TypeError("Claude Tool Host attachment requires an actor id and tool catalog.");
  }
  return {
    actorId: attachment.actorId,
    mcpServers: { ...(providerOptions.mcpServers ?? {}) },
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
