import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";

export const CODEX_APP_SERVER_PROVIDER_ID = "codex-app-server";

export function createCodexAppServerProvider(operations, options = {}) {
  return new CallbackAgentProvider({
    id: CODEX_APP_SERVER_PROVIDER_ID,
    displayName: "Codex",
    transport: "app-server",
    metadata: options.metadata ?? {},
    capabilities: options.capabilities ?? [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_AVATAR_UPDATE,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_CLEAR,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
      AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
      AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
      AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
      AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE,
      AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION,
      AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT,
      AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ,
      AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
      AGENT_PROVIDER_CAPABILITIES.TURN_CHANGES_MANAGE
    ]
  }, operations);
}

export function codexToolHostAttachment(attachment, providerOptions = {}) {
  if (!attachment?.actorId || !Array.isArray(attachment?.tools)) {
    throw new TypeError("Codex Tool Host attachment requires an actor id and tool catalog.");
  }
  return {
    ...providerOptions,
    dynamicTools: attachment.tools.map((tool) => ({ ...tool })),
    dynamicToolAgentId: attachment.actorId
  };
}
