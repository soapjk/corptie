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
  AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE,
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
  AGENT_PROVIDER_CAPABILITIES.SKILL_LAZY_LOAD,
  AGENT_PROVIDER_CAPABILITIES.SKILL_MCP_DEPENDENCIES,
  AGENT_PROVIDER_CAPABILITIES.TURN_CHANGES_MANAGE
]);

export function createAgentProviderRuntimeRegistry(options = {}) {
  const providers = [
    requiredProvider(options.claudeProvider, "claudeProvider"),
    createCodexAppServerProvider(options.codexOperations ?? {}, {
      metadata: options.codexMetadata ?? {},
      capabilities: CODEX_APP_SERVER_CAPABILITIES
    }),
    ...materializeAdditionalProviders(options.additionalProviders, options.providerContext)
  ];

  return new AgentProviderRegistry(providers, {
    defaultProviderId: options.defaultProviderId ?? "codex-app-server"
  });
}

export { claudeToolHostAttachment, codexToolHostAttachment };

function requiredProvider(provider, name) {
  if (!provider) throw new TypeError(`Agent Provider bootstrap requires ${name}.`);
  return provider;
}

function materializeAdditionalProviders(additionalProviders, context = {}) {
  if (additionalProviders == null) return [];
  if (!Array.isArray(additionalProviders)) {
    throw new TypeError("Agent Provider bootstrap additionalProviders must be an array.");
  }
  return additionalProviders.map((entry, index) => {
    const provider = typeof entry === "function" ? entry(context ?? {}) : entry;
    if (!provider || typeof provider !== "object") {
      throw new TypeError(`Agent Provider bootstrap entry ${index} did not produce a Provider.`);
    }
    return provider;
  });
}
