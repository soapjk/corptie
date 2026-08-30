import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";
import { CallbackAgentProvider } from "../callbackAgentProvider.mjs";

export const OPENCLACKY_PROVIDER_ID = "openclacky";

export function openClackyToolSchemaCapabilities(manager) {
  const bridge = manager?.probe?.capabilities ?? {};
  const toolHost = bridge.toolHost === true;
  return Object.freeze({
    bootstrapAttach: toolHost,
    appendInPlace: false,
    replaceAtTurnBoundary: bridge.toolHostReplace === true,
    generatedMcpRefresh: false,
    restrictedGateway: toolHost,
    bindingReplacement: false,
    capabilityRevision: `openclacky:tool-schema:3:${manager?.probe?.protocolVersion ?? "unprobed"}:${toolHost ? "gateway" : "unsupported"}`
  });
}

// Capabilities that OpenClacky can always advertise regardless of the bridge
// handshake. These are the honest baseline for basic chat and session lifecycle.
const OPENCLACKY_BASE_CAPABILITIES = Object.freeze([
  AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
  AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
  AGENT_PROVIDER_CAPABILITIES.SESSION_FAILED_BINDING_RECOVERY,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
  AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
  AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
  AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
  AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH
]);

// Capabilities gated behind a healthy Corptie bridge handshake. They are only
// declared after the runtime probe confirms bridge support, so the UI never shows
// a false "available" for Tool Host or Workspace transition.
const OPENCLACKY_BRIDGE_CAPABILITIES = Object.freeze([
  AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH,
  AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION,
  AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ
]);

export function createOpenClackyProvider(manager, options = {}) {
  if (!manager) throw new TypeError("OpenClacky Provider requires a manager.");
  return new CallbackAgentProvider({
    id: OPENCLACKY_PROVIDER_ID,
    displayName: "OpenClacky",
    transport: "http-websocket",
    aliases: ["clacky", "open-clacky"],
    protocolVersion: "corptie-bridge-v1",
    runtime: { lifecycle: "managed" },
    metadata: { ...(options.metadata ?? {}), toolSchemaCapabilities: openClackyToolSchemaCapabilities(manager) },
    configuration: {
      fields: [
        { id: "baseURL", type: "url", label: "Server URL", required: true, defaultValue: "http://127.0.0.1:7070" },
        { id: "accessKey", type: "secret", label: "Access Key", required: false }
      ]
    },
    capabilities: openClackyCapabilities(manager, options)
  }, {
    createSession: (input) => manager.create(input),
    resumeSession: (reference, context = {}) => manager.resume(reference.providerSessionId, {
      toolHost: context.toolHost ?? null
    }),
    deleteSession: (reference) => manager.delete(reference.providerSessionId),
    renameSession: (reference, title) => manager.rename(reference.providerSessionId, title),
    send: (reference, message, context = {}) => manager.send(reference.providerSessionId, message, {
      ...context,
      turnId: context.turnId ?? context.idempotencyKey ?? null
    }),
    interrupt: (reference) => manager.interrupt(reference.providerSessionId),
    respondToApproval: (reference, approval) => manager.respondToApproval(reference.providerSessionId, approval),
    listModels: () => manager.listModels(),
    switchModel: (reference, modelId) => manager.switchModel(reference.providerSessionId, modelId),
    switchReasoning: (reference, level) => manager.switchReasoning(reference.providerSessionId, level),
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
    ...(typeof options.readSessionUsage === "function"
      ? { readSessionUsage: options.readSessionUsage }
      : {}),
    probeToolSchemaCapabilities: options.probeToolSchemaCapabilities
      ?? (() => openClackyToolSchemaCapabilities(manager)),
    ...(typeof options.applyToolPlanAtTurnBoundary === "function"
      ? { applyToolPlanAtTurnBoundary: options.applyToolPlanAtTurnBoundary }
      : {})
  });
}

// Compute the capability list from the manager's runtime probe. The probe is
// populated asynchronously; when absent, fall back to the base set only so an
// un-probed or unhealthy bridge never over-claims capability.
export function openClackyCapabilities(manager, options = {}) {
  const probe = manager?.probe ?? null;
  const result = probe?.capabilities ?? null;
  const capabilities = new Set(OPENCLACKY_BASE_CAPABILITIES);
  if (result?.toolHost && typeof options.attachTools === "function") {
    capabilities.add(AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH);
  }
  if (result?.workspaceTransition && typeof options.prepareWorkspaceTransition === "function") {
    capabilities.add(AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION);
  }
  if (typeof options.readSessionUsage === "function") {
    capabilities.add(AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ);
  }
  if (typeof options.bindWorkspace === "function" && typeof options.inspectWorkspaceBinding === "function") {
    capabilities.add(AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND);
  }
  return [...capabilities].sort();
}
