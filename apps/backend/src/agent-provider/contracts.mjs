export const AGENT_PROVIDER_CAPABILITIES = Object.freeze({
  SESSION_CREATE: "session.create",
  SESSION_RESUME: "session.resume",
  SESSION_DELETE: "session.delete",
  SESSION_RESTART: "session.restart",
  SESSION_DISCONNECT: "session.disconnect",
  SESSION_RENAME: "session.rename",
  SESSION_EXECUTION_PREPARE: "session.execution.prepare",
  SESSION_BINDING_PROBE: "session.binding.probe",
  SESSION_RECOVERY_STABILIZE: "session.recovery.stabilize",
  SESSION_FAILED_BINDING_RECOVERY: "session.failedBinding.recover",
  CONVERSATION_SEND: "conversation.send",
  CONVERSATION_CLEAR: "conversation.clear",
  CONVERSATION_INTERRUPT: "conversation.interrupt",
  CONVERSATION_APPROVE: "conversation.approve",
  MODEL_LIST: "configuration.model.list",
  MODEL_SWITCH: "configuration.model.switch",
  REASONING_SWITCH: "configuration.reasoning.switch",
  PERMISSIONS_UPDATE: "configuration.permissions.update",
  WORKSPACE_TRANSITION: "workspace.transition",
  WORKSPACE_BIND: "workspace.bind",
  BACKGROUND_PROMPT: "background.prompt",
  ACCOUNT_USAGE_READ: "usage.account.read",
  SESSION_USAGE_READ: "usage.session.read",
  TOOL_HOST_ATTACH: "tools.attach",
  SKILL_LAZY_LOAD: "agent.skills.lazyLoad",
  SKILL_MCP_DEPENDENCIES: "agent.skills.mcpDependencies",
  TURN_CHANGES_MANAGE: "turn.changes.manage"
});

// SESSION_FAILED_BINDING_RECOVERY、SKILL_LAZY_LOAD、SKILL_MCP_DEPENDENCIES 与 TURN_CHANGES_MANAGE
// 是「会话编排/上下文组装」型能力，
// 不映射到具体 Provider 方法，因此未出现在下方 METHOD_BY_CAPABILITY 映射中。
// 懒加载 Skill 的「工具注入」由 TOOL_HOST_ATTACH（attachTools）独立负责，
// 这些能力是独立开关，不应耦合声明。
export const AGENT_PROVIDER_METHOD_BY_CAPABILITY = Object.freeze({
  [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE]: "createSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME]: "resumeSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE]: "deleteSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART]: "restartSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT]: "disconnectSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME]: "renameSession",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE]: "prepareExecution",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_BINDING_PROBE]: "probeBinding",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_RECOVERY_STABILIZE]: "stabilizeRecoverySession",
  [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]: "send",
  [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_CLEAR]: "clearConversation",
  [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT]: "interrupt",
  [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE]: "respondToApproval",
  [AGENT_PROVIDER_CAPABILITIES.MODEL_LIST]: "listModels",
  [AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH]: "switchModel",
  [AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH]: "switchReasoning",
  [AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE]: "updatePermissions",
  [AGENT_PROVIDER_CAPABILITIES.WORKSPACE_TRANSITION]: "prepareWorkspaceTransition",
  [AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND]: "bindWorkspace",
  [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT]: "runBackgroundPrompt",
  [AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ]: "readAccountUsage",
  [AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ]: "readSessionUsage",
  [AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH]: "attachTools",
  [AGENT_PROVIDER_CAPABILITIES.TURN_CHANGES_MANAGE]: "manageTurnChanges"
});

// Product reads are Corptie Store operations, not Provider operations. A
// Provider may expose private transport diagnostics, but the shared product
// contract intentionally has no Session list/history/snapshot read method.
const REQUIRED_PROVIDER_METHODS = Object.freeze([]);

const OPTIONAL_PROVIDER_METHODS = Object.freeze([
  "prepareSessionInput"
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
  for (const method of OPTIONAL_PROVIDER_METHODS) {
    if (provider[method] != null && typeof provider[method] !== "function") {
      throw new AgentProviderContractError(
        `Agent Provider ${descriptor.id} ${method} must be a function when provided.`,
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
  if (descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND)
    && typeof provider.inspectWorkspaceBinding !== "function") {
    throw new AgentProviderContractError(
      `Agent Provider ${descriptor.id} declares workspace.bind but does not implement inspectWorkspaceBinding().`,
      { providerId: descriptor.id, capability: AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND, method: "inspectWorkspaceBinding" }
    );
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
  const aliases = normalizedAliases(input?.aliases, id);
  const capabilities = Array.isArray(input?.capabilities)
    ? [...new Set(input.capabilities.map((value) => normalizedRequiredString(value, "descriptor.capabilities[]")))].sort()
    : [];
  return {
    id,
    displayName,
    transport,
    protocolVersion: normalizedOptionalString(input?.protocolVersion),
    aliases,
    capabilities,
    runtime: normalizeRuntimeDescriptor(input?.runtime),
    configuration: normalizeConfigurationDescriptor(input?.configuration),
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

function normalizedAliases(input, providerId) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new AgentProviderContractError("descriptor.aliases must be an array.", {
      providerId,
      field: "descriptor.aliases"
    });
  }
  const aliases = input.map((value) => normalizedProviderIdentity(value, "descriptor.aliases[]"));
  return [...new Set(aliases)].filter((alias) => alias !== normalizedProviderIdentity(providerId, "descriptor.id")).sort();
}

function normalizeRuntimeDescriptor(input) {
  if (input == null) return { lifecycle: "external" };
  if (!isPlainObject(input)) {
    throw new AgentProviderContractError("descriptor.runtime must be an object.", {
      field: "descriptor.runtime"
    });
  }
  const lifecycle = normalizedOptionalString(input.lifecycle) ?? "external";
  if (!["external", "managed", "hybrid"].includes(lifecycle)) {
    throw new AgentProviderContractError(
      "descriptor.runtime.lifecycle must be external, managed, or hybrid.",
      { field: "descriptor.runtime.lifecycle", lifecycle }
    );
  }
  return {
    ...input,
    lifecycle
  };
}

function normalizeConfigurationDescriptor(input) {
  if (input == null) return { fields: [] };
  if (!isPlainObject(input)) {
    throw new AgentProviderContractError("descriptor.configuration must be an object.", {
      field: "descriptor.configuration"
    });
  }
  const fields = input.fields ?? [];
  if (!Array.isArray(fields)) {
    throw new AgentProviderContractError("descriptor.configuration.fields must be an array.", {
      field: "descriptor.configuration.fields"
    });
  }
  const ids = new Set();
  const normalizedFields = fields.map((field, index) => {
    if (!isPlainObject(field)) {
      throw new AgentProviderContractError("Provider configuration fields must be objects.", {
        field: `descriptor.configuration.fields[${index}]`
      });
    }
    const id = normalizedRequiredString(field.id, `descriptor.configuration.fields[${index}].id`);
    const type = normalizedRequiredString(field.type, `descriptor.configuration.fields[${index}].type`);
    if (ids.has(id)) {
      throw new AgentProviderContractError(`Duplicate Provider configuration field: ${id}`, {
        field: "descriptor.configuration.fields",
        configurationFieldId: id
      });
    }
    ids.add(id);
    return { ...field, id, type };
  });
  return { ...input, fields: normalizedFields };
}

function normalizedProviderIdentity(value, field) {
  return normalizedRequiredString(value, field).toLowerCase();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
