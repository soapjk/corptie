import { AgentProviderRegistry } from "../agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";
import {
  codexToolHostAttachment,
  createCodexAppServerProvider
} from "../providers/codexAppServerProvider.mjs";
import { claudeToolHostAttachment } from "../providers/claudeAgentSdkProvider.mjs";

const CODEX_APP_SERVER_CAPABILITIES = Object.freeze([
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_CLEAR,
  AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_AVATAR_UPDATE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE,
  AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION,
  AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT,
  AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ,
  AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ,
  AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
  AGENT_PROVIDER_CAPABILITIES.TURN_CHANGES_MANAGE
]);

export function createAgentProviderRuntimeRegistry(options = {}) {
  const providers = [
    requiredProvider(options.claudeProvider, "claudeProvider"),
    createCodexAppServerProvider(options.codexOperations ?? {}, {
      metadata: options.codexMetadata ?? {},
      capabilities: CODEX_APP_SERVER_CAPABILITIES
    })
  ];

  return new AgentProviderRegistry(providers);
}

export { claudeToolHostAttachment, codexToolHostAttachment };

function requiredProvider(provider, name) {
  if (!provider) throw new TypeError(`Agent Provider bootstrap requires ${name}.`);
  return provider;
}
