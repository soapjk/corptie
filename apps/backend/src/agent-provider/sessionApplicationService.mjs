import { AGENT_PROVIDER_CAPABILITIES, AgentProviderNotFoundError } from "./contracts.mjs";
import { SingleFlight } from "../utils/singleFlight.mjs";
import { SESSION_COMMAND_CATALOG, validateSessionCommand, sessionCommandAvailability,
  sessionCommandPermissions, sessionCommandError } from "../commands/sessionCommandCatalog.mjs";

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
    this.persistModelSelection = options.persistModelSelection ?? null;
    this.resolveMessageContext = options.resolveMessageContext ?? null;
    this.assertMessageDispatchAllowed = options.assertMessageDispatchAllowed ?? null;
    this.recoverUnavailableSession = options.recoverUnavailableSession ?? null;
    this.toolHostService = options.toolHostService ?? null;
    this.toolMaterializationPort = options.toolMaterializationPort ?? null;
    this.resolveRequiredToolDomains = options.resolveRequiredToolDomains ?? (() => []);
    this.observeLifecycle = options.observeLifecycle ?? (() => {});
    this.toolReadinessFlights = new SingleFlight();
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
    const { forkSource: _forkSource, ...attachmentContext } = context;
    const bootstrapContext = this.#materializationContext({
      ...attachmentContext,
      sessionKind: context.sessionKind ?? preparedInput.sessionKind ?? "legacy"
    });
    const toolHost = hasPreparedToolHost
      ? context.preparedToolHost
      : this.toolHostService
        ? await this.toolHostService.prepareSession(providerId, {
            purpose: "session-bootstrap",
            ...bootstrapContext
          })
        : null;
    const forkSource = context.forkSource ?? null;
    if (forkSource && forkSource.reference?.providerId !== providerId) {
      throw new TypeError("A conversation fork must retain its Provider.");
    }
    const session = await this.registry.invoke(
      providerId,
      forkSource ? AGENT_PROVIDER_CAPABILITIES.SESSION_FORK : AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE,
      toolHost ? { ...preparedInput, toolHost } : preparedInput,
      context
    );
    let reference = null;
    try {
      reference = this.bindCreatedSession && context.deferSessionBinding !== true
        ? await this.bindCreatedSession({ providerId, session, input: preparedInput, context })
        : null;
    } catch (error) {
      // A failed bind can leave a persisted projection without an executable
      // route. Remove only this newly created resource, preserving the cause.
      const failedReference = {
        sessionId: session.id,
        providerId,
        providerSessionId: session.external?.sessionId ?? session.external?.threadId ?? session.id
      };
      try {
        await this.registry.invoke(providerId, AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE, failedReference, context);
      } catch (cleanupError) {
        this.observeLifecycle({ type: "SessionCreationCleanupFailed", providerId, sessionId: session.id, errorCode: cleanupError?.code ?? "PROVIDER_CLEANUP_FAILED" });
      }
      if (this.removeSessionBinding) await this.removeSessionBinding({ reference: failedReference });
      throw error;
    }
    if (context.deferToolHostFinalization !== true) {
      try {
        await this.#finalizeCreatedSessionTools(providerId, preparedInput, context, reference);
      } catch (error) {
        // Another committed route now owns this logical Session. Never let stale
        // creation cleanup tombstone or detach the replacement binding.
        if (error?.cause?.code === "SESSION_BINDING_CHANGED") throw error;
        const failedReference = {
          sessionId: reference?.sessionId ?? session.id,
          logicalSessionId: reference?.logicalSessionId ?? null,
          bindingId: reference?.bindingId ?? reference?.providerBindingId ?? null,
          providerId,
          providerSessionId: reference?.providerSessionId
            ?? session.external?.sessionId
            ?? session.external?.threadId
            ?? session.id
        };
        try {
          await this.registry.invoke(
            providerId,
            AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
            failedReference,
            context
          );
        } catch (cleanupError) {
          this.observeLifecycle({
            type: "SessionCreationCleanupFailed",
            providerId,
            sessionId: failedReference.sessionId,
            errorCode: cleanupError?.code ?? "PROVIDER_CLEANUP_FAILED"
          });
        }
        if (this.removeSessionBinding) {
          try {
            await this.removeSessionBinding({ reference: failedReference });
          } catch (cleanupError) {
            this.observeLifecycle({
              type: "SessionCreationCleanupFailed",
              providerId,
              sessionId: failedReference.sessionId,
              errorCode: cleanupError?.code ?? "LOCAL_BINDING_CLEANUP_FAILED"
            });
          }
        }
        throw error;
      }
    }
    return this.decorateLifecycleSession(providerId, session, reference);
  }

  async #finalizeCreatedSessionTools(providerId, input, context, reference) {
    const actorId = normalizedText(context.actorId ?? input.toolHost?.actorId);
    if (!reference || !this.toolHostService || !actorId) return;
    if (!this.registry.supports(providerId, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH)) return;
    try {
      await this.ensureActiveBindingToolsReady(reference.sessionId, {
        ...context,
        purpose: "session-create-finalization",
        actorId,
        sessionKind: context.sessionKind ?? input.sessionKind ?? "legacy",
        expectedLogicalSessionId: reference.logicalSessionId ?? null,
        expectedProviderBindingId: reference.bindingId ?? reference.providerBindingId ?? null,
        expectedProviderSessionId: reference.providerSessionId ?? null,
        expectedRoutingVersion: reference.routingVersion ?? null,
        ...((reference.providerSessionId
          && (reference.bindingId ?? reference.providerBindingId)
          && reference.routingVersion != null) ? {
          resolvedReference: {
            ...reference,
            providerId: reference.providerId ?? providerId
          }
        } : {}),
        forceProviderResume: true
      });
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
    const ready = await this.ensureActiveBindingToolsReady(sessionId, {
      ...context,
      purpose: normalizedText(context.purpose) ?? "session-resume",
      forceProviderResume: true
    });
    return this.decorateLifecycleSession(ready.reference.providerId, ready.providerSession, ready.reference);
  }

  async ensureActiveBindingToolsReady(sessionId, context = {}) {
    const reference = context.resolvedReference
      ? normalizeSessionReference(context.resolvedReference, sessionId)
      : await this.referenceFor(sessionId);
    assertTaskNotArchived(reference);
    assertExpectedBinding(reference, context);
    const storedSession = reference.metadata?.session ?? context.before ?? null;
    const actorId = normalizedText(storedSession?.agentId) ?? normalizedText(context.actorId);
    const {
      expectedLogicalSessionId: _expectedLogicalSessionId,
      expectedProviderBindingId: _expectedProviderBindingId,
      expectedProviderSessionId: _expectedProviderSessionId,
      expectedRoutingVersion: _expectedRoutingVersion,
      resolvedReference: _resolvedReference,
      forceProviderResume: _forceProviderResume,
      ...providerContext
    } = context;
    const readinessContext = this.#materializationContext({
      ...providerContext,
      purpose: normalizedText(context.purpose) ?? "session-tool-readiness",
      actorId,
      sessionId: reference.sessionId,
      logicalSessionId: reference.logicalSessionId ?? null,
      sessionKind: storedSession?.sessionKind ?? context.sessionKind ?? "legacy",
      workId: normalizedText(storedSession?.workId) ?? normalizedText(context.workId),
      taskId: normalizedText(storedSession?.taskId) ?? normalizedText(context.taskId),
      ...(reference.bindingId ? { providerBindingId: reference.bindingId } : {})
    });
    const attachesToolHost = Boolean(this.toolHostService
      && readinessContext.actorId
      && this.registry.supports(
        reference.providerId,
        AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH
      ));
    const key = [
      reference.logicalSessionId ?? reference.sessionId,
      reference.bindingId ?? "unbound",
      reference.providerSessionId,
      reference.routingVersion ?? "unversioned",
      normalizedText(readinessContext.actorId) ?? "actorless",
      normalizedText(readinessContext.workId) ?? "workless",
      normalizedText(readinessContext.taskId) ?? "taskless",
      readinessContext.activeTurn === true ? "active-turn" : "idle-turn",
      readinessContext.sessionKind,
      context.forceProviderResume === true ? "forced-resume" : "readiness",
      attachesToolHost ? "attachment" : "gate",
      ...readinessContext.desiredToolDomains
    ].join("\0");
    const lookupSessionId = reference.requestedSessionId
      ?? reference.logicalSessionId
      ?? reference.sessionId;
    let ownsPreparation = false;
    const ready = await this.toolReadinessFlights.run(key, () => {
      ownsPreparation = true;
      return this.#prepareActiveBindingTools(reference, readinessContext, { ...context, lookupSessionId });
    });
    if (ownsPreparation) return ready;
    // Every joining waiter owns its route/scope fences, even when another lifecycle
    // purpose performed the shared Provider preparation.
    const current = await this.referenceFor(lookupSessionId);
    assertSameBinding(reference, current);
    assertSameToolScope(reference, current);
    assertExpectedBinding(current, context);
    await this.#ensureDomains(readinessContext, readinessContext.desiredToolDomains);
    const finalReference = await this.referenceFor(lookupSessionId);
    assertSameBinding(current, finalReference);
    assertSameToolScope(current, finalReference);
    assertExpectedBinding(finalReference, context);
    return ready;
  }

  async #prepareActiveBindingTools(reference, readinessContext, options) {
    const desiredDomains = readinessContext.desiredToolDomains;
    const canAttach = this.toolHostService
      && readinessContext.actorId
      && this.registry.supports(reference.providerId, AGENT_PROVIDER_CAPABILITIES.TOOL_HOST_ATTACH);
    let preparedMaterialization = null;
    if (options.forceProviderResume !== true) {
      try {
        const materialization = await this.#ensureDomains(readinessContext, desiredDomains);
        const current = await this.referenceFor(options.lookupSessionId ?? reference.sessionId);
        assertSameBinding(reference, current);
        assertSameToolScope(reference, current);
        assertExpectedBinding(current, options);
        return Object.freeze({
          reference: current,
          providerSession: current.metadata?.session ?? null,
          materialization
        });
      } catch (error) {
        if (!canAttach || !providerObservationCanBeRepaired(error)) throw error;
        preparedMaterialization = error.preparedMaterialization ?? null;
      }
    }
    const toolHost = canAttach
      ? await this.toolHostService.prepareSession(reference.providerId, readinessContext, {
        preparedMaterialization
      })
      : null;
    const preparedReference = await this.referenceFor(
      options.lookupSessionId ?? reference.sessionId
    );
    assertSameBinding(reference, preparedReference);
    assertSameToolScope(reference, preparedReference);
    assertExpectedBinding(preparedReference, options);
    let providerSession = reference.metadata?.session ?? null;
    if (toolHost || options.forceProviderResume === true) {
      this.registry.requireCapability(reference.providerId, AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME);
      providerSession = await this.registry.invoke(
        reference.providerId,
        AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
        reference,
        toolHost ? { ...readinessContext, toolHost } : readinessContext
      );
    }
    if (toolHost?.materialization?.status === "applying") {
      await this.toolHostService.confirmPreparedSession(toolHost);
    }
    const materialization = await this.#ensureDomains(readinessContext, desiredDomains);
    const current = await this.referenceFor(options.lookupSessionId ?? reference.sessionId);
    assertSameBinding(reference, current);
    assertSameToolScope(reference, current);
    assertExpectedBinding(current, options);
    return Object.freeze({
      reference: current,
      providerSession: providerSession ?? current.metadata?.session ?? null,
      materialization
    });
  }

  async prepareExecution(sessionId, context = {}) {
    const reference = await this.referenceFor(sessionId);
    this.registry.requireCapability(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.SESSION_EXECUTION_PREPARE
    );
    const storedSession = reference.metadata?.session ?? null;
    const actorId = normalizedText(context.actorId ?? storedSession?.agentId);
    const materializationContext = this.#materializationContext({
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
    });
    await this.#ensureRequiredDomains(materializationContext);
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
    return this.#ensureDomains(context, this.resolveRequiredToolDomains(context));
  }

  async #ensureDomains(context, domains) {
    if (!this.toolMaterializationPort) return null;
    const requestedDomains = Array.isArray(domains) ? domains : [];
    const logicalSessionId = normalizedText(context.logicalSessionId ?? context.sessionId);
    if (!logicalSessionId) {
      const error = new Error("Required Tool domains need an authenticated logical Session.");
      error.code = "SESSION_BINDING_CHANGED";
      throw error;
    }
    const boundary = {
      turnExecutionId: context.turnExecutionId ?? context.turnId ?? null,
      purpose: context.purpose,
      activeTurn: context.activeTurn === true,
      ...(context.allowPendingProviderObservation === true
        ? { allowPendingProviderObservation: true }
        : {})
    };
    if (requestedDomains.length > 0) {
      return this.toolMaterializationPort.ensureDomainsApplied(
        logicalSessionId,
        requestedDomains,
        boundary
      );
    }
    return typeof this.toolMaterializationPort.ensureCurrentApplied === "function"
      ? this.toolMaterializationPort.ensureCurrentApplied(logicalSessionId, boundary)
      : null;
  }

  #materializationContext(context = {}) {
    const { forkSource: _forkSource, ...attachmentContext } = context;
    const required = this.resolveRequiredToolDomains(context);
    const desired = Array.isArray(context.desiredToolDomains) ? context.desiredToolDomains : [];
    return {
      ...attachmentContext,
      desiredToolDomains: [...new Set([
        ...desired,
        ...(Array.isArray(required) ? required : [])
      ].map((domain) => normalizedText(domain)).filter(Boolean))].sort()
    };
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
    assertTaskNotArchived(reference);
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
    const sessionKind = reference.metadata?.session?.sessionKind ?? null;
    if (["worker", "workChat"].includes(sessionKind)) {
      const error = new Error("Task and Work Chat Session names are derived from their owning resource.");
      error.code = "SESSION_TITLE_DERIVED";
      error.statusCode = 409;
      throw error;
    }
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

  async listConversationCommands(sessionId) {
    const reference = await this.referenceFor(sessionId);
    assertTaskNotArchived(reference);
    const provider = this.registry.get(reference.providerId).descriptor;
    return SESSION_COMMAND_CATALOG.map(descriptor => ({
      name: descriptor.name, usage: descriptor.usage, summary: descriptor.summary,
      available: sessionCommandAvailability(descriptor, provider),
      reason: sessionCommandAvailability(descriptor, provider) ? null : "CAPABILITY_UNSUPPORTED",
      requiredPermissions: sessionCommandPermissions({ name: descriptor.name, arguments: "" }),
      requiresConfirmation: descriptor.requiresConfirmation === true
    }));
  }

  async validateConversationCommand(sessionId, command) {
    const descriptor = validateSessionCommand(command);
    const reference = await this.referenceFor(sessionId);
    assertTaskNotArchived(reference);
    if (!sessionCommandAvailability(descriptor, this.registry.get(reference.providerId).descriptor, command)) {
      throw sessionCommandError("CAPABILITY_UNSUPPORTED", "当前会话不支持此命令。", 409);
    }
    return reference;
  }

  async executeCommand(sessionId, command, context = {}) {
    const reference = await this.referenceFor(sessionId);
    assertTaskNotArchived(reference);
    validateSessionCommand(command);
    await this.assertMessageDispatchAllowed?.(reference, context);
    const args = command.arguments;
    if (command.name === "help") {
      const commands = await this.listConversationCommands(sessionId);
      return { text: commands.map(item => `${item.usage}：${item.summary}${item.available ? "" : "（当前会话不支持）"}`).join("\n") };
    }
    if (command.name === "model") {
      if (!args) {
        const catalog = await this.listModelsForSession(sessionId);
        return { text: JSON.stringify(catalog, null, 2) };
      }
      await this.switchModel(sessionId, args, context);
      return { text: `模型已切换为 ${args}` };
    }
    if (command.name === "reasoning" || command.name === "rename") {
      if (!args) throw Object.assign(new Error(`/${command.name} 需要参数。`), { statusCode: 400 });
      if (command.name === "rename") await this.renameSession(sessionId, args, context);
      else await this.switchReasoning(sessionId, args, context);
      return { text: `/${command.name} 已应用：${args}` };
    }
    if (command.name === "status") {
      if (args) throw Object.assign(new Error("/status 不接受参数。"), { statusCode: 400 });
      const session = reference.metadata?.session;
      return { text: `Session：${reference.logicalSessionId ?? reference.sessionId}\n模型：${session?.external?.currentModel ?? "默认"}\n状态：${session?.status ?? "未知"}` };
    }
    this.registry.requireCapability(reference.providerId, AGENT_PROVIDER_CAPABILITIES.CONVERSATION_COMMAND);
    // Read/stop/pause operations must not materialize tools or replace a binding
    // underneath a running turn. Only commands that can start work need preparation.
    if (["compact", "review"].includes(command.name)
        || (command.name === "goal" && args && !["pause", "clear"].includes(args))) {
      try {
        await this.prepareExecution(sessionId, context);
      } catch (error) {
        error.commandStage = "command_prepare";
        throw error;
      }
    }
    // Resolve again after preparation: never send control RPCs to a stale binding.
    const prepared = await this.referenceFor(sessionId);
    try {
      return await this.registry.invoke(prepared.providerId, AGENT_PROVIDER_CAPABILITIES.CONVERSATION_COMMAND,
        prepared, command, context);
    } catch (error) {
      error.commandStage = "command_execute";
      throw error;
    }
  }

  async sendMessage(sessionId, message, context = {}) {
    let reference;
    try {
      reference = await this.referenceFor(sessionId);
      assertTaskNotArchived(reference);
      await this.assertMessageDispatchAllowed?.(reference, context);
    } catch (error) {
      throw withDispatchStateNotSent(error);
    }
    let ready;
    try {
      ready = await this.ensureActiveBindingToolsReady(reference.requestedSessionId, {
        ...context,
        purpose: "conversation-turn-boundary",
        resolvedReference: reference,
        expectedLogicalSessionId: reference.logicalSessionId,
        expectedProviderBindingId: reference.bindingId,
        expectedProviderSessionId: reference.providerSessionId,
        expectedRoutingVersion: reference.routingVersion,
        activeTurn: false
      });
    } catch (error) {
      throw withDispatchStateNotSent(error);
    }
    const prepared = ready.reference;
    let sessionContext;
    let dispatchReference;
    try {
      await this.assertMessageDispatchAllowed?.(prepared, context);
      sessionContext = this.resolveMessageContext
        ? await this.resolveMessageContext(prepared, { ...context, message })
        : null;
      dispatchReference = await this.referenceFor(prepared.requestedSessionId);
      assertSameBinding(prepared, dispatchReference);
      await this.assertMessageDispatchAllowed?.(dispatchReference, context);
    } catch (error) {
      throw withDispatchStateNotSent(error);
    }
    if (sessionContext?.contextIntegrity) {
      console.info(`[worker-context-dispatch] ${JSON.stringify({
        sessionId: dispatchReference.sessionId,
        providerId: dispatchReference.providerId,
        taskId: sessionContext.contextIntegrity.taskId,
        taskRevision: sessionContext.contextIntegrity.taskRevision,
        taskDefinitionSha256: sessionContext.contextIntegrity.taskDefinitionSha256,
        corePromptSha256: sessionContext.contextIntegrity.corePromptSha256,
        finalPromptSha256: sessionContext.contextIntegrity.finalPromptSha256,
        finalUtf8Bytes: sessionContext.contextBudget?.finalTurnUtf8Bytes ?? null,
        omittedOptionalArtifacts: sessionContext.contextBudget?.omittedOptionalArtifacts ?? 0,
        omissionReasons: sessionContext.contextBudget?.omissionReasons ?? {}
      })}`);
    }
    return this.registry.invoke(
      dispatchReference.providerId,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      dispatchReference,
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

  async respondToUserInput(sessionId, input, context = {}) {
    const reference = await this.referenceFor(sessionId);
    return this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_USER_INPUT,
      reference,
      input,
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
    const providerSession = await this.registry.invoke(
      reference.providerId,
      AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH,
      reference,
      modelId,
      context
    );
    return this.persistModelSelection
      ? await this.persistModelSelection({ reference, modelId, providerSession, context })
      : providerSession;
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
    return normalizeSessionReference(
      await this.resolveSessionReference(normalizedSessionId),
      normalizedSessionId
    );
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

function normalizeSessionReference(reference, requestedSessionId) {
  const normalizedSessionId = normalizedText(requestedSessionId);
  if (!normalizedSessionId || !reference?.providerId || !reference?.providerSessionId) {
    throw new SessionNotFoundError(normalizedSessionId ?? String(requestedSessionId ?? ""));
  }
  return Object.freeze({
    sessionId: reference.sessionId ?? normalizedSessionId,
    requestedSessionId: reference.requestedSessionId ?? normalizedSessionId,
    logicalSessionId: reference.logicalSessionId ?? null,
    bindingId: reference.bindingId ?? reference.providerBindingId ?? null,
    providerId: reference.providerId,
    providerSessionId: reference.providerSessionId,
    routingVersion: reference.routingVersion ?? null,
    metadata: reference.metadata ?? (reference.session ? { session: reference.session } : {})
  });
}

function assertExpectedBinding(reference, expected = {}) {
  const mismatched = (expected.expectedLogicalSessionId != null
      && reference.logicalSessionId !== expected.expectedLogicalSessionId)
    || (expected.expectedProviderBindingId != null
      && reference.bindingId !== expected.expectedProviderBindingId)
    || (expected.expectedProviderSessionId != null
      && reference.providerSessionId !== expected.expectedProviderSessionId)
    || (expected.expectedRoutingVersion != null
      && reference.routingVersion !== expected.expectedRoutingVersion);
  if (!mismatched) return;
  const error = new Error("The Provider binding generation changed during Tool Host readiness.");
  error.code = "SESSION_BINDING_CHANGED";
  error.statusCode = 409;
  throw error;
}

function assertSameBinding(expected, current) {
  const matches = current.logicalSessionId === expected.logicalSessionId
    && current.bindingId === expected.bindingId
    && current.providerId === expected.providerId
    && current.providerSessionId === expected.providerSessionId
    && current.routingVersion === expected.routingVersion;
  if (matches) return;
  const error = new Error("The Provider binding generation changed during Tool Host readiness.");
  error.code = "SESSION_BINDING_CHANGED";
  error.statusCode = 409;
  throw error;
}

function assertSameToolScope(expected, current) {
  const expectedSession = expected.metadata?.session ?? null;
  const currentSession = current.metadata?.session ?? null;
  const fields = ["agentId", "workId", "taskId", "sessionKind"];
  if (fields.every((field) => (
    normalizedText(currentSession?.[field]) === normalizedText(expectedSession?.[field])
  ))) return;
  const error = new Error("The Session Tool authorization scope changed during readiness.");
  error.code = "SESSION_BINDING_CHANGED";
  error.statusCode = 409;
  throw error;
}

function providerObservationCanBeRepaired(error) {
  return error?.recoveryAction === "observe_generated_mcp";
}

function withDispatchStateNotSent(error) {
  if (error != null && (typeof error === "object" || typeof error === "function")) {
    if (error.dispatchState === "not_sent") return error;
    try {
      error.dispatchState = "not_sent";
      if (error.dispatchState === "not_sent") return error;
    } catch {
      // Frozen Provider errors are wrapped below without losing their structured fields.
    }
  }
  const wrapped = new Error(error?.message ?? String(error), {
    ...(error instanceof Error ? { cause: error } : {})
  });
  for (const field of ["code", "statusCode", "stage", "recoveryAction", "replacementReason"]) {
    if (error?.[field] != null) wrapped[field] = error[field];
  }
  wrapped.dispatchState = "not_sent";
  return wrapped;
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

function assertTaskNotArchived(reference) {
  if (reference.metadata?.session?.archiveReason !== "taskArchived") return;
  const error = new Error("请先恢复归档 Task，再继续执行。");
  Object.assign(error, { code: "TASK_ARCHIVED", statusCode: 409 });
  throw error;
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}
