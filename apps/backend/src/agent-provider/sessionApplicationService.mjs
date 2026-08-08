import { AGENT_PROVIDER_CAPABILITIES } from "./contracts.mjs";

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
    if (!this.registry) throw new TypeError("SessionApplicationService requires an Agent Provider Registry.");
    if (typeof this.resolveSessionReference !== "function") {
      throw new TypeError("SessionApplicationService requires resolveSessionReference().");
    }
  }

  listSessions(options = {}) {
    return this.registry.listSessions(options);
  }

  async readSession(sessionId) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.get(reference.providerId).readSession(reference);
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
}
