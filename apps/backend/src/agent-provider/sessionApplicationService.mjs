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
    this.persistRenamedSession = options.persistRenamedSession ?? null;
    this.resolveMessageContext = options.resolveMessageContext ?? null;
    this.recoverUnavailableSession = options.recoverUnavailableSession ?? null;
    this.toolHostService = options.toolHostService ?? null;
    if (!this.registry) throw new TypeError("SessionApplicationService requires an Agent Provider Registry.");
    if (typeof this.resolveSessionReference !== "function") {
      throw new TypeError("SessionApplicationService requires resolveSessionReference().");
    }
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
    if (Object.prototype.hasOwnProperty.call(input, "avatarPath")) {
      const error = new TypeError("Session avatars are not supported; sessions inherit their Agent avatar.");
      error.code = "SESSION_AVATAR_UNSUPPORTED";
      throw error;
    }
    const provider = this.registry.get(providerId);
    const preparedInput = typeof provider.prepareSessionInput === "function"
      ? await provider.prepareSessionInput(input, context)
      : input;
    const toolHost = this.toolHostService
      ? await this.toolHostService.prepareSession(providerId, { purpose: "session-bootstrap", ...context })
      : null;
    const session = await this.registry.invoke(
      providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      toolHost ? { ...preparedInput, toolHost } : preparedInput,
      context
    );
    const reference = this.bindCreatedSession && context.deferSessionBinding !== true
      ? await this.bindCreatedSession({ providerId, session, input: preparedInput, context })
      : null;
    await this.#finalizeCreatedSessionTools(providerId, preparedInput, context, reference);
    return this.decorateLifecycleSession(providerId, session, reference);
  }

  async #finalizeCreatedSessionTools(providerId, input, context, reference) {
    const actorId = normalizedText(context.actorId ?? input.toolHost?.actorId);
    if (!reference || !this.toolHostService || !actorId) return;
    if (!this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH)) return;
    this.registry.requireCapability(providerId, AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME);
    const finalizationContext = {
      ...context,
      purpose: "session-create-finalization",
      actorId,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId ?? null,
      sessionKind: context.sessionKind ?? input.sessionKind ?? "legacy",
      objectiveId: context.objectiveId ?? null,
      workItemId: context.workItemId ?? null
    };
    try {
      const toolHost = await this.toolHostService.prepareSession(providerId, finalizationContext);
      await this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
        reference,
        toolHost ? { ...finalizationContext, toolHost } : finalizationContext
      );
    } catch (cause) {
      const error = new Error(`Session Tool Host finalization failed: ${cause?.message ?? cause}`);
      error.code = "SESSION_TOOL_MATERIALIZATION_FAILED";
      error.stage = "tool_host_finalization";
      error.cause = cause;
      throw error;
    }
  }

  // A route transition creates only the target Provider thread. The coordinator
  // subsequently binds that thread to the existing logical Session atomically.
  // Running the ordinary bindCreatedSession hook here would incorrectly create
  // a second logical Session and collide with the original canonical name.
  async createSessionForRouteTransition(providerId, input = {}, context = {}) {
    return this.createSession(providerId, input, {
      ...context,
      deferSessionBinding: true
    });
  }

  async resumeSession(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    const storedSession = reference.metadata?.session ?? null;
    const actorId = normalizedText(context.actorId ?? storedSession?.agentId);
    const resumeContext = {
      ...context,
      purpose: "session-resume",
      actorId,
      sessionId: reference.sessionId,
      sessionKind: storedSession?.sessionKind ?? context.sessionKind ?? "legacy",
      objectiveId: storedSession?.objectiveId ?? context.objectiveId ?? null,
      workItemId: storedSession?.workItemId ?? context.workItemId ?? null
    };
    const toolHost = this.toolHostService && actorId
      ? await this.toolHostService.prepareSession(reference.providerId, resumeContext)
      : null;
    const session = await this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      reference,
      toolHost ? { ...resumeContext, toolHost } : resumeContext
    );
    return this.decorateLifecycleSession(reference.providerId, session, reference);
  }

  async prepareExecution(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    this.registry.requireCapability(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE
    );
    const storedSession = reference.metadata?.session ?? null;
    const actorId = normalizedText(context.actorId ?? storedSession?.agentId);
    const materializationContext = {
      actorId,
      purpose: "session",
      sessionKind: storedSession?.sessionKind ?? context.sessionKind ?? "legacy",
      objectiveId: storedSession?.objectiveId ?? context.objectiveId ?? null,
      workItemId: storedSession?.workItemId ?? context.workItemId ?? null,
      sessionId: reference.sessionId
    };
    const toolHost = this.toolHostService && actorId
      ? await this.toolHostService.prepareSession(reference.providerId, materializationContext)
      : null;
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE,
      reference,
      toolHost
        ? { ...context, ...materializationContext, toolHost }
        : { ...context, ...materializationContext }
    );
  }

  async deleteSession(sessionId, context = {}) {
    return this.#deleteSession(sessionId, context, false);
  }

  // Replacement is allowed only after the caller has proved that the old
  // Provider Session never began execution. In that narrow case, a missing or
  // already-deleted Provider thread must not leave a duplicate local Session
  // behind after its replacement is running.
  async deleteUnusableSession(sessionId, context = {}) {
    return this.#deleteSession(sessionId, context, true);
  }

  async #deleteSession(sessionId, context, removeLocalBindingOnProviderFailure) {
    const reference = await this.referenceFor(sessionId);
    let providerResult = false;
    let providerError = null;
    try {
      providerResult = await this.registry.invoke(
        reference.providerId,
        AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
        reference,
        context
      );
    } catch (error) {
      if (!removeLocalBindingOnProviderFailure) throw error;
      providerError = error;
    }
    if (this.removeSessionBinding) {
      await this.removeSessionBinding({ reference, providerResult, providerError, context });
    }
    return {
      ok: true,
      deleted: providerError !== null || providerResult !== false,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId,
      providerId: reference.providerId,
      ...(removeLocalBindingOnProviderFailure ? {
        providerDeleted: providerError === null && providerResult !== false,
        providerErrorCode: providerError?.code ?? null
      } : {})
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
    const normalizedTitle = requiredText(title, "title");
    const providerSession = await this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RENAME,
      reference,
      normalizedTitle,
      context
    );
    return this.persistRenamedSession
      ? await this.persistRenamedSession({ reference, title: normalizedTitle, providerSession, context })
      : providerSession;
  }

  async sendMessage(sessionId, message, context = {}) {
    let reference = await this.referenceFor(sessionId);
    const dispatch = async () => {
      const sessionContext = this.resolveMessageContext
        ? await this.resolveMessageContext(reference, { ...context, message })
        : null;
      return this.registry.invoke(
        reference.providerId,
        AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
        reference,
        message,
        sessionContext ? { ...context, sessionContext } : context
      );
    };
    try {
      return await dispatch();
    } catch (error) {
      if (typeof this.recoverUnavailableSession !== "function"
        || error?.dispatchState !== "not_sent"
        || error?.recoveryAction !== "replace_provider_binding") {
        throw error;
      }
      const recovered = await this.recoverUnavailableSession({
        sessionId,
        reference,
        error,
        context
      });
      reference = recovered?.reference ?? await this.referenceFor(sessionId);
      return dispatch();
    }
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
    const normalizedLevel = requiredText(level, "reasoning level").toLowerCase();
    const currentModel = normalizedText(reference.metadata?.session?.external?.currentModel);
    if (currentModel) {
      const catalog = await this.listModels(reference.providerId, context);
      validateReasoningLevelForModel({
        modelId: currentModel,
        reasoningLevel: normalizedLevel,
        models: catalog?.models
      });
    }
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.REASONING_SWITCH,
      reference,
      normalizedLevel,
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

export function validateReasoningLevelForModel({ modelId, reasoningLevel, models = [] } = {}) {
  const model = Array.isArray(models)
    ? models.find((candidate) => candidate?.id === modelId)
    : null;
  const levels = Array.isArray(model?.reasoningLevels)
    ? model.reasoningLevels.map((level) => normalizedText(level)?.toLowerCase()).filter(Boolean)
    : [];
  if (levels.length === 0 || levels.includes(reasoningLevel)) return reasoningLevel;
  const error = new RangeError(`Reasoning level ${reasoningLevel} is not supported by model ${modelId}.`);
  error.code = "UNSUPPORTED_REASONING_LEVEL";
  throw error;
}

function normalizedText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}
