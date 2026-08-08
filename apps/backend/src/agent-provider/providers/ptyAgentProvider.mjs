import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";

export const GENERIC_PTY_PROVIDER_ID = "pty";
export const CODEX_PTY_PROVIDER_ID = "codex-pty";

export function createPtyAgentProvider(manager, options = {}) {
  if (!manager) throw new TypeError("PTY Agent Provider requires a manager.");
  const providerId = options.providerId ?? GENERIC_PTY_PROVIDER_ID;
  const isCodex = providerId === CODEX_PTY_PROVIDER_ID;
  const capabilities = [
    AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
    AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
    AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
    ...(typeof options.listModels === "function" ? [AGENT_PROVIDER_CAPABILITIES.MODEL_LIST] : []),
    ...(isCodex
      ? [
          AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
          AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH
        ]
      : [])
  ];
  return new CallbackAgentProvider({
    id: providerId,
    displayName: options.displayName ?? (isCodex ? "Codex CLI (Legacy)" : "Terminal Agent"),
    transport: "pty",
    capabilities
  }, {
    listSessions: (input) => manager.list(input).filter((session) => session.external?.provider === providerId),
    readSession: (reference) => manager.detail(reference.providerSessionId),
    createSession: (input) => manager.start({ ...input, provider: providerId }),
    resumeSession: (reference) => manager.reconnect(reference.providerSessionId),
    deleteSession: (reference) => manager.delete(reference.providerSessionId),
    send: (reference, message, context = {}) => {
      manager.write(reference.providerSessionId, message, { submit: context.submit !== false });
      return manager.detail(reference.providerSessionId, { flush: false });
    },
    interrupt: (reference) => manager.interrupt(reference.providerSessionId),
    respondToApproval: (reference, approval) => {
      if (isCodex && approval?.itemType === "approval") {
        return manager.respondToCodexApproval(reference.providerSessionId, approval);
      }
      return manager.respondToPtyChoice(reference.providerSessionId, approval);
    },
    ...(typeof options.listModels === "function" ? { listModels: options.listModels } : {}),
    ...(isCodex ? {
      switchModel: (reference, modelId) => manager.switchModel(reference.providerSessionId, modelId),
      switchReasoning: (reference, level) => manager.switchReasoning(reference.providerSessionId, level)
    } : {})
  });
}
