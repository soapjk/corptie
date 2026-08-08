import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";

export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-sdk";

export function createClaudeAgentSdkProvider(manager, options = {}) {
  if (!manager) throw new TypeError("Claude Agent SDK Provider requires a manager.");
  return new CallbackAgentProvider({
    id: CLAUDE_AGENT_SDK_PROVIDER_ID,
    displayName: "Claude Code",
    transport: "agent-sdk",
    metadata: { backgroundPermissionProfiles: ["read-only"] },
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_AVATAR_UPDATE,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
      ...(typeof options.listModels === "function" ? [AGENT_PROVIDER_CAPABILITIES.MODEL_LIST] : []),
      AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
      AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT
    ]
  }, {
    listSessions: (options) => manager.list(options),
    readSession: (reference) => manager.detail(reference.providerSessionId),
    createSession: (input) => manager.start(input),
    resumeSession: (reference) => manager.reconnect(reference.providerSessionId),
    deleteSession: (reference) => manager.delete(reference.providerSessionId),
    renameSession: (reference, title) => manager.rename(reference.providerSessionId, title),
    updateAvatar: (reference, avatarPath) => manager.updateAvatar(reference.providerSessionId, avatarPath),
    send: (reference, message) => manager.send(reference.providerSessionId, message),
    interrupt: (reference) => manager.interrupt(reference.providerSessionId),
    respondToApproval: (reference, approval) => manager.respondToChoice(reference.providerSessionId, approval),
    ...(typeof options.listModels === "function" ? { listModels: options.listModels } : {}),
    switchModel: (reference, modelId) => manager.switchModel(reference.providerSessionId, modelId),
    runBackgroundPrompt: (input) => manager.runBackgroundPrompt(input)
  });
}
