import { AGENT_PROVIDER_CAPABILITIES, AgentProviderNotFoundError } from "./contracts.mjs";

export class SessionNotFoundError extends Error {
  constructor(sessionId) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
    this.code = "SESSION_NOT_FOUND";
    this.sessionId = sessionId;
  }
}

export class SessionApplicationService {
  constructor(options = {}) {
    this.registry = options.registry;
    this.resolveSessionReference = options.resolveSessionReference;
    this.resolveSessionBinding = options.resolveSessionBinding ?? null;
    this.bindCreatedSession = options.bindCreatedSession ?? null;
    this.removeSessionBinding = options.removeSessionBinding ?? null;
    this.toolHostService = options.toolHostService ?? null;
    if (!this.registry) throw new TypeError("SessionApplicationService requires an Agent Provider Registry.");
    if (typeof this.resolveSessionReference !== "function") {
      throw new TypeError("SessionApplicationService requires resolveSessionReference().");
    }
  }

  listSessions(options = {}) {
    return this.registry.listSessions(options);
  }

  listModels(providerId, context = {}) {
    try {
      return this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.MODEL_LIST,
        context
      );
    } catch (error) {
      // Unknown providers must not crash the process. Frontends may still
      // request models for a legacy / unregistered provider id; degrade to an
      // empty model list so the caller can fall back gracefully.
      if (error instanceof AgentProviderNotFoundError) {
        return { models: [], currentModel: null, currentReasoningLevel: null };
      }
      throw error;
    }
  }

  async listModelsForSession(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    const catalog = await this.listModels(reference.providerId, context);
    const session = reference.metadata?.session ?? null;
    return {
      providerId: reference.providerId,
      providerName: this.registry.get(reference.providerId).descriptor.displayName,
      models: Array.isArray(catalog?.models) ? catalog.models : [],
      currentModel: session?.external?.currentModel ?? catalog?.currentModel ?? null,
      currentReasoningLevel: session?.external?.currentReasoningLevel
        ?? catalog?.currentReasoningLevel
        ?? null
    };
  }

  async createSession(providerId, input = {}, context = {}) {
    const provider = this.registry.get(providerId);
    const preparedInput = typeof provider.prepareSessionInput === "function"
      ? await provider.prepareSessionInput(input, context)
      : input;
    const toolHost = this.toolHostService
      ? await this.toolHostService.prepareSession(providerId, { purpose: "session", ...context })
      : null;
    const session = await this.registry.invoke(
      providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      toolHost ? { ...preparedInput, toolHost } : preparedInput,
      context
    );
    const reference = this.bindCreatedSession
      ? await this.bindCreatedSession({ providerId, session, input: preparedInput, context })
      : null;
    return this.decorateLifecycleSession(providerId, session, reference);
  }

  async resumeSession(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    const session = await this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      reference,
      context
    );
    return this.decorateLifecycleSession(reference.providerId, session, reference);
  }

  async deleteSession(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    const providerResult = await this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
      reference,
      context
    );
    if (this.removeSessionBinding) {
      await this.removeSessionBinding({ reference, providerResult, context });
    }
    return {
      ok: true,
      deleted: providerResult !== false,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId,
      providerId: reference.providerId
    };
  }

  async restartSession(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
      reference,
      context
    );
  }

  async disconnectSession(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_DISCONNECT,
      reference,
      context
    );
  }

  async renameSession(sessionId, title, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
      reference,
      requiredText(title, "title"),
      context
    );
  }

  async updateAvatar(sessionId, avatarPath, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_AVATAR_UPDATE,
      reference,
      typeof avatarPath === "string" && avatarPath.trim() ? avatarPath.trim() : null,
      context
    );
  }

  async readSession(sessionId) {
    const reference = await this.referenceFor(sessionId);
    const session = await this.registry.get(reference.providerId).readSession(reference);
    return this.registry.decorateSession(reference.providerId, session);
  }

  async readSessionBinding(sessionId, bindingId) {
    if (!this.resolveSessionBinding) {
      throw new SessionNotFoundError(sessionId);
    }
    const reference = await this.resolveSessionBinding(sessionId, bindingId);
    if (!reference?.providerId || !reference?.providerSessionId) {
      throw new SessionNotFoundError(sessionId);
    }
    const session = await this.registry.get(reference.providerId).readSession(reference);
    return this.registry.decorateSession(reference.providerId, session);
  }

  async sendMessage(sessionId, message, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      reference,
      message,
      context
    );
  }

  async clearConversation(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_CLEAR,
      reference,
      context
    );
  }

  async interrupt(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT,
      reference,
      context
    );
  }

  async respondToApproval(sessionId, approval, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_APPROVE,
      reference,
      approval,
      context
    );
  }

  async manageTurnChanges(sessionId, turnId, action, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.TURN_CHANGES_MANAGE,
      reference,
      requiredText(turnId, "turnId"),
      requiredText(action, "action"),
      context
    );
  }

  async switchModel(sessionId, modelId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
      reference,
      modelId,
      context
    );
  }

  async switchReasoning(sessionId, level, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
      reference,
      level,
      context
    );
  }

  async updatePermissions(sessionId, permissions, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.PERMISSIONS_UPDATE,
      reference,
      permissions,
      context
    );
  }

  async readAccountUsage(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.ACCOUNT_USAGE_READ,
      reference,
      context
    );
  }

  async readSessionUsage(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_USAGE_READ,
      reference,
      context
    );
  }

  async referenceFor(sessionId) {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) throw new SessionNotFoundError(String(sessionId ?? ""));
    const reference = await this.resolveSessionReference(normalizedSessionId);
    if (!reference?.providerId || !reference?.providerSessionId) {
      throw new SessionNotFoundError(normalizedSessionId);
    }
    return Object.freeze({
      sessionId: reference.sessionId ?? normalizedSessionId,
      requestedSessionId: reference.requestedSessionId ?? normalizedSessionId,
      logicalSessionId: reference.logicalSessionId ?? null,
      bindingId: reference.bindingId ?? null,
      providerId: reference.providerId,
      providerSessionId: reference.providerSessionId,
      routingVersion: reference.routingVersion ?? null,
      metadata: reference.metadata ?? {}
    });
  }

  decorateLifecycleSession(providerId, session, reference = null) {
    const decorated = this.registry.decorateSession(providerId, reference?.session ?? session);
    const legacySessionId = reference?.sessionId ?? decorated.id ?? null;
    const logicalSessionId = reference?.logicalSessionId ?? null;
    return {
      ...decorated,
      id: legacySessionId,
      sessionId: legacySessionId,
      logicalSessionId,
      publicSessionId: logicalSessionId ?? legacySessionId
    };
  }
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}
