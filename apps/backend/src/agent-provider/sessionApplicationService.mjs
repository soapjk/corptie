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
    this.assertMessageDispatchAllowed = options.assertMessageDispatchAllowed ?? null;
    this.recoverUnavailableSession = options.recoverUnavailableSession ?? null;
    this.toolHostService = options.toolHostService ?? null;
    this.toolMaterializationPort = options.toolMaterializationPort ?? null;
    this.resolveRequiredToolDomains = options.resolveRequiredToolDomains ?? (() => []);
    this.observeLifecycle = options.observeLifecycle ?? (() => {});
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
    const hasPreparedToolHost = Object.prototype.hasOwnProperty.call(context, "preparedToolHost");
    if (hasPreparedToolHost && context.deferSessionBinding !== true) {
      throw new TypeError("A prepared Tool Host attachment is only valid for an internal route transition.");
    }
    const toolHost = hasPreparedToolHost
      ? context.preparedToolHost
      : this.toolHostService
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
    if (context.deferToolHostFinalization !== true) {
      await this.#finalizeCreatedSessionTools(providerId, preparedInput, context, reference);
    }
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
      ...(reference.bindingId ?? reference.providerBindingId
        ? { providerBindingId: reference.bindingId ?? reference.providerBindingId }
        : {}),
      sessionKind: context.sessionKind ?? input.sessionKind ?? "legacy",
      workId: context.workId ?? null,
      taskId: context.taskId ?? null
    };
    try {
      const toolHost = await this.toolHostService.prepareSession(providerId, finalizationContext);
      await this.#ensureRequiredDomains(finalizationContext);
      await this.registry.invoke(
        providerId,
        AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
        reference,
        toolHost ? { ...finalizationContext, toolHost } : finalizationContext
      );
      if (toolHost?.materialization?.status === "applying") {
        await this.toolHostService.confirmPreparedSession(toolHost);
      }
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
      purpose: normalizedText(context.purpose) ?? "session-resume",
      actorId,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId ?? null,
      sessionKind: storedSession?.sessionKind ?? context.sessionKind ?? "legacy",
      workId: storedSession?.workId ?? context.workId ?? null,
      taskId: storedSession?.taskId ?? context.taskId ?? null,
      ...(reference.bindingId ?? reference.providerBindingId
        ? { providerBindingId: reference.bindingId ?? reference.providerBindingId }
        : {})
    };
    const toolHost = this.toolHostService && actorId
      ? await this.toolHostService.prepareSession(reference.providerId, resumeContext)
      : null;
    await this.#ensureRequiredDomains(resumeContext);
    const session = await this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
      reference,
      toolHost ? { ...resumeContext, toolHost } : resumeContext
    );
    if (toolHost?.materialization?.status === "applying") {
      await this.toolHostService.confirmPreparedSession(toolHost);
    }
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
      workId: storedSession?.workId ?? context.workId ?? null,
      taskId: storedSession?.taskId ?? context.taskId ?? null,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId ?? null,
      ...(reference.bindingId ?? reference.providerBindingId
        ? { providerBindingId: reference.bindingId ?? reference.providerBindingId }
        : {})
    };
    const toolHost = this.toolHostService && actorId
      ? await this.toolHostService.prepareSession(reference.providerId, materializationContext)
      : null;
    await this.#ensureRequiredDomains(materializationContext);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE,
      reference,
      toolHost
        ? { ...context, ...materializationContext, toolHost }
        : { ...context, ...materializationContext }
    );
  }

  // Readiness belongs to the concrete Session binding, not to its owning Task
  // or to the Provider process as a whole. Every adapter must implement the
  // same probe contract using its own authoritative protocol operation.
  async probeBindingReadiness(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_BINDING_PROBE,
      reference,
      context
    );
  }

  async deleteSession(sessionId, context = {}) {
    return this.#deleteSession(sessionId, context, false);
  }

  // A Task owns its associated Session resources. Deleting that Task must not
  // leave the local ownership graph permanently blocked because an external
  // Provider is unavailable or its delete operation times out. Provider
  // cleanup is still attempted first and its result is returned for audit,
  // while the product binding is retired regardless of Provider availability.
  async deleteSessionForTaskDeletion(sessionId, context = {}) {
    return this.#deleteSession(sessionId, context, true);
  }

  async #ensureRequiredDomains(context) {
    if (!this.toolMaterializationPort) return null;
    const domains = this.resolveRequiredToolDomains(context);
    if (!Array.isArray(domains) || domains.length === 0) return null;
    const logicalSessionId = normalizedText(context.logicalSessionId ?? context.sessionId);
    if (!logicalSessionId) {
      const error = new Error("Required Tool domains need an authenticated logical Session.");
      error.code = "SESSION_BINDING_CHANGED";
      throw error;
    }
    return this.toolMaterializationPort.ensureDomainsApplied(logicalSessionId, domains, {
      turnExecutionId: context.turnExecutionId ?? context.turnId ?? null,
      purpose: context.purpose
    });
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
    const audit = restartAudit(reference, context);
    this.observeLifecycle({ type: "SessionRestartRequested", ...audit });
    try {
      const result = await this.registry.invoke(
        reference.providerId,
        AGENT_PROVIDER_CAPABILITIES.SESSION_RESTART,
        reference,
        context
      );
      this.observeLifecycle({ type: "SessionRestartInvocationCompleted", ...audit, resultStatus: result?.status ?? null });
      return result;
    } catch (error) {
      if (!this.#canReplaceProviderBinding(error)) {
        this.observeLifecycle({ type: "SessionRestartInvocationFailed", ...audit, errorCode: error?.code ?? "SESSION_RESTART_FAILED" });
        throw error;
      }
      try {
        const recovered = await this.recoverUnavailableSession({
          sessionId,
          reference,
          error,
          context: { ...context, recoveryKind: "restart" }
        });
        const recoveredReference = recovered?.reference ?? await this.referenceFor(sessionId);
        const result = {
          status: "completed",
          recovered: true,
          recoveryAction: "provider_binding_replaced",
          sessionId: recoveredReference.sessionId,
          logicalSessionId: recoveredReference.logicalSessionId,
          providerBindingId: recoveredReference.bindingId,
          routingVersion: recoveredReference.routingVersion
        };
        this.observeLifecycle({ type: "SessionRestartInvocationCompleted", ...audit, resultStatus: result.status, recovered: true });
        return result;
      } catch (recoveryError) {
        this.observeLifecycle({ type: "SessionRestartInvocationFailed", ...audit, errorCode: recoveryError?.code ?? "SESSION_RECOVERY_FAILED" });
        throw recoveryError;
      }
    }
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
    const reference = await this.referenceFor(sessionId);
    await this.assertMessageDispatchAllowed?.(reference, context);
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
  }

  #canReplaceProviderBinding(error) {
    return typeof this.recoverUnavailableSession === "function"
      && error?.dispatchState === "not_sent"
      && error?.recoveryAction === "replace_provider_binding";
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

function restartAudit(reference, context) {
  return Object.freeze({
    sessionId: reference.sessionId,
    logicalSessionId: reference.logicalSessionId,
    providerId: reference.providerId,
    providerBindingId: reference.bindingId,
    providerSessionId: reference.providerSessionId,
    routingVersion: reference.routingVersion,
    source: normalizedText(context.source) ?? "unknown",
    actorId: normalizedText(context.actorId),
    actorSessionId: normalizedText(context.actorSessionId),
    idempotencyKey: normalizedText(context.idempotencyKey)
  });
}

function normalizedText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}
