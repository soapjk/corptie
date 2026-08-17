import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";
import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";

export const OPENCLACKY_PROVIDER_ID = "openclacky";

export function createOpenClackyProvider(manager) {
  if (!manager) throw new TypeError("OpenClacky Provider requires a manager.");
  return new CallbackAgentProvider({
    id: OPENCLACKY_PROVIDER_ID,
    displayName: "OpenClacky",
    transport: "http-websocket",
    aliases: ["clacky", "open-clacky"],
    protocolVersion: "native-v1",
    runtime: { lifecycle: "external" },
    configuration: {
      fields: [
        { id: "baseURL", type: "url", label: "Server URL", required: true, defaultValue: "http://127.0.0.1:7070" },
        { id: "accessKey", type: "secret", label: "Access Key", required: false }
      ]
    },
    capabilities: [
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
      AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
      AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
      AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH
    ]
  }, {
    listSessions: (options) => manager.list(options),
    readSession: (reference) => manager.read(reference.providerSessionId),
    createSession: (input) => manager.create(input),
    resumeSession: (reference) => manager.resume(reference.providerSessionId),
    deleteSession: (reference) => manager.delete(reference.providerSessionId),
    renameSession: (reference, title) => manager.rename(reference.providerSessionId, title),
    send: (reference, message, context = {}) => manager.send(reference.providerSessionId, message, context),
    interrupt: (reference) => manager.interrupt(reference.providerSessionId),
    respondToApproval: (reference, approval) => manager.respondToApproval(reference.providerSessionId, approval),
    listModels: () => manager.listModels(),
    switchModel: (reference, modelId) => manager.switchModel(reference.providerSessionId, modelId),
    switchReasoning: (reference, level) => manager.switchReasoning(reference.providerSessionId, level)
  });
}
