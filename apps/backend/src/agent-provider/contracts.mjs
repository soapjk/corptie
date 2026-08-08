export const AGENT_PROVIDER_CAPABILITIES = Object.freeze({
  SESSION_CREATE: "session.create",
  SESSION_RESUME: "session.resume",
  SESSION_DELETE: "session.delete",
  SESSION_RESTART: "session.restart",
  SESSION_DISCONNECT: "session.disconnect",
  SESSION_RENAME: "session.rename",
  SESSION_AVATAR_UPDATE: "session.avatar.update",
  CONVERSATION_SEND: "conversation.send",
  CONVERSATION_INTERRUPT: "conversation.interrupt",
  CONVERSATION_APPROVE: "conversation.approve",
  MODEL_LIST: "configuration.model.list",
  MODEL_SWITCH: "configuration.model.switch",
  REASONING_SWITCH: "configuration.reasoning.switch",
  PERMISSIONS_UPDATE: "configuration.permissions.update",
  WORKSPACE_TRANSITION: "workspace.transition",
  BACKGROUND_PROMPT: "background.prompt",
  ACCOUNT_USAGE_READ: "usage.account.read",
  SESSION_USAGE_READ: "usage.session.read",
  TOOL_HOST_ATTACH: "tools.attach"
});

export const AGENT_PROVIDER_METHOD_BY_CAPABILITY = Object.freeze({
  [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE]: "createSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME]: "resumeSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE]: "deleteSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART]: "restartSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT]: "disconnectSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME]: "renameSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_AVATAR_UPDATE]: "updateAvatar",
  [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]: "send",
  [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT]: "interrupt",
  [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE]: "respondToApproval",
  [AGENT_PROVIDER_CAPABILITIES.MODEL_LIST]: "listModels",
  [AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH]: "switchModel",
  [AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH]: "switchReasoning",
  [AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE]: "updatePermissions",
  [AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION]: "prepareWorkspaceTransition",
  [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT]: "runBackgroundPrompt",
  [AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ]: "readAccountUsage",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ]: "readSessionUsage",
  [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH]: "attachTools"
});

const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "listSessions",
  "readSession"
]);

export class AgentProviderContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AgentProviderContractError";
    this.code = "AGENT_PROVIDER_CONTRACT_INVALID";
    this.details = details;
  }
}

export class AgentProviderCapabilityError extends Error {
  constructor(providerId, capability) {
    super(`Agent Provider ${providerId} does not support ${capability}.`);
    this.name = "AgentProviderCapabilityError";
    this.code = "CAPABILITY_UNSUPPORTED";
    this.providerId = providerId;
    this.capability = capability;
  }
}

export class AgentProviderNotFoundError extends Error {
  constructor(providerId) {
    super(`Agent Provider not found: ${providerId}`);
    this.name = "AgentProviderNotFoundError";
    this.code = "AGENT_PROVIDER_NOT_FOUND";
    this.providerId = providerId;
  }
}

export function validateAgentProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new AgentProviderContractError("Agent Provider must be an object.");
  }
  const descriptor = normalizeAgentProviderDescriptor(provider.descriptor);
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new AgentProviderContractError(
        `Agent Provider ${descriptor.id} must implement ${method}().`,
        { providerId: descriptor.id, method }
      );
    }
  }
  for (const capability of descriptor.capabilities) {
    const method = AGENT_PROVIDER_METHOD_BY_CAPABILITY[capability];
    if (!method) continue;
    if (typeof provider[method] !== "function") {
      throw new AgentProviderContractError(
        `Agent Provider ${descriptor.id} declares ${capability} but does not implement ${method}().`,
        { providerId: descriptor.id, capability, method }
      );
    }
  }
  return Object.freeze({
    ...descriptor,
    capabilities: Object.freeze([...descriptor.capabilities])
  });
}

export function normalizeAgentProviderDescriptor(input) {
  const id = normalizedRequiredString(input?.id, "descriptor.id");
  const displayName = normalizedRequiredString(input?.displayName, "descriptor.displayName");
  const transport = normalizedRequiredString(input?.transport, "descriptor.transport");
  const capabilities = Array.isArray(input?.capabilities)
    ? [...new Set(input.capabilities.map((value) => normalizedRequiredString(value, "descriptor.capabilities[]")))].sort()
    : [];
  return {
    id,
    displayName,
    transport,
    protocolVersion: normalizedOptionalString(input?.protocolVersion),
    capabilities,
    metadata: isPlainObject(input?.metadata) ? { ...input.metadata } : {}
  };
}

export function providerSupports(providerOrDescriptor, capability) {
  const capabilities = providerOrDescriptor?.descriptor?.capabilities
    ?? providerOrDescriptor?.capabilities
    ?? [];
  return Array.isArray(capabilities) && capabilities.includes(capability);
}

function normalizedRequiredString(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new AgentProviderContractError(`${field} must be a non-empty string.`, { field });
  }
  return normalized;
}

function normalizedOptionalString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
