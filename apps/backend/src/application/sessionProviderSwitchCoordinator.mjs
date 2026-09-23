import { createHash, randomUUID } from "node:crypto";
import { SessionNotFoundError } from "../agent-provider/sessionApplicationService.mjs";
import { toolDefinitionsContractHash } from "./hostToolCatalog.mjs";

// Provider-neutral coordinator for switching a logical Session from its current
// Session Provider to another one. It reuses the workspace_transitions state
// machine with transition_kind='provider' (fork strategy) so the existing
// routing_version optimistic-concurrency and in-flight-transition mutual
// exclusion apply unchanged. It is deliberately independent of any concrete
// Provider: the target session is created through the shared SESSION_CREATE
// capability, and the "title + instruction summary" context migration is the
// only user-content carried into the new thread (history is never deleted or
// replayed). Provider bindings that advertise binding-replacement Tool
// materialization additionally require an exact target-thread schema proof and
// commit their prospective applied materialization in the route transaction.
export class SessionProviderSwitchCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.registry = options.registry;
    this.resolveSessionReference = options.resolveSessionReference;
    this.createTargetSession = options.createTargetSession ?? null;
    this.resumeTargetSession = options.resumeTargetSession ?? null;
    this.resolveTargetContext = options.resolveTargetContext ?? null;
    this.confirmToolSchema = options.confirmToolSchema ?? null;
    this.prepareToolMaterialization = options.prepareToolMaterialization ?? null;
    this.finalizeCommittedTarget = options.finalizeCommittedTarget ?? null;
    this.requiresAtomicToolMaterialization = options.requiresAtomicToolMaterialization
      ?? (({ providerId }) => providerRequiresAtomicToolMaterialization(this.registry, providerId));
    this.hasActiveRun = options.hasActiveRun ?? (() => false);
    this.onTransitionEvent = options.onTransitionEvent ?? (() => {});
    if (!this.store) throw new TypeError("SessionProviderSwitchCoordinator requires a store.");
    if (!this.registry) throw new TypeError("SessionProviderSwitchCoordinator requires a Provider Registry.");
    if (typeof this.resolveSessionReference !== "function") {
      throw new TypeError("SessionProviderSwitchCoordinator requires resolveSessionReference().");
    }
    if (typeof this.createTargetSession !== "function") {
      throw new TypeError("SessionProviderSwitchCoordinator requires createTargetSession().");
    }
  }

  async switchProvider(sessionId, input = {}) {
    const reference = await this.resolveSessionReference(sessionId);
    if (!reference?.providerId || !reference?.providerSessionId) {
      throw new SessionNotFoundError(sessionId);
    }
    const requestedTargetProviderId = requiredText(input.providerId, "providerId");
    const targetProviderId = this.registry.resolveId(requestedTargetProviderId);
    if (!targetProviderId) {
      const error = new Error(`Session Provider ${requestedTargetProviderId} is not available.`);
      error.code = "PROVIDER_UNSUPPORTED";
      throw error;
    }
    const logical = reference.logicalSessionId
      ? this.store.getLogicalSession(reference.logicalSessionId)
      : this.store.getLogicalSessionByLegacySessionId(reference.sessionId);
    if (!logical?.activeBinding) {
      const error = new Error("The Session has no active Provider binding to switch.");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    // Only an explicitly identified, still-current committed switch can retry
    // Tool Host finalization. Do not turn a same-Provider request into a new switch.
    const requestedTransition = input.transitionId
      ? this.store.getWorkspaceTransition(input.transitionId)
      : null;
    const committedRetry = requestedTransition?.phase === "committed"
      ? requestedTransition
      : null;
    if (committedRetry) {
      if (committedRetry.transitionId !== input.transitionId
        || committedRetry.transitionKind !== "provider"
        || committedRetry.logicalSessionId !== logical.logicalSessionId
        || committedRetry.targetProviderId !== targetProviderId) {
        throw providerSwitchRecoveryError(
          "The committed transition does not match the requested Session and Provider.",
          "PROVIDER_SWITCH_TRANSITION_MISMATCH"
        );
      }
      assertCommittedRetryReference(committedRetry, logical, reference);
    }
    if (input.expectedRoutingVersion != null
      && Number(input.expectedRoutingVersion) !== logical.routingVersion
      && !(committedRetry
        && Number(input.expectedRoutingVersion) === committedRetry.sourceRoutingVersion)) {
      const error = new Error(`The Session route changed from version ${input.expectedRoutingVersion} to ${logical.routingVersion}.`);
      error.code = "STALE_SESSION_ROUTE";
      error.statusCode = 409;
      error.expectedRoutingVersion = Number(input.expectedRoutingVersion);
      error.currentRoutingVersion = logical.routingVersion;
      error.logicalSessionId = logical.logicalSessionId;
      throw error;
    }
    if (committedRetry) {
      return this.finalizeCommittedProviderSwitch(committedRetry, reference, logical);
    }
    const replacingFailedBinding = input.replaceFailedBinding === true
      && logical.activeBinding.providerId === targetProviderId;
    if (logical.activeBinding.providerId === targetProviderId && !replacingFailedBinding) {
      const error = new Error("The Session is already bound to the requested Provider.");
      error.code = "PROVIDER_ALREADY_ACTIVE";
      throw error;
    }
    if (replacingFailedBinding && reference.metadata?.session?.status !== "failed") {
      const error = new Error("The active Provider Session is not failed and cannot be replaced automatically.");
      error.code = "PROVIDER_SESSION_REPLACEMENT_NOT_ALLOWED";
      throw error;
    }

    const active = this.hasActiveRun(reference.metadata?.session);
    const transitionId = input.transitionId || `provider-transition:${randomUUID()}`;
    const transition = this.store.beginWorkspaceTransition({
      transitionId,
      logicalSessionId: logical.logicalSessionId,
      transitionKind: "provider",
      targetProviderId,
      targetCwd: logical.activeBinding.boundCwd,
      sourceRoutingVersion: logical.routingVersion,
      resumeGoalAfterTransition: Boolean(active),
      strategy: "fork",
      phase: active ? "waitingForTurn" : "preflighting"
    });

    this.onTransitionEvent("ProviderSwitchPending", {
      sessionId: reference.sessionId,
      logicalSessionId: logical.logicalSessionId,
      transitionId,
      fromProviderId: logical.activeBinding.providerId,
      toProviderId: targetProviderId,
      routingVersion: logical.routingVersion,
      status: active ? "waitingForTurn" : "committed"
    });

    if (active) {
      return {
        status: "waitingForTurn",
        transition,
        fromProviderId: logical.activeBinding.providerId,
        toProviderId: targetProviderId
      };
    }

    return this.completeProviderSwitch(transitionId, targetProviderId, reference, logical);
  }

  async recoverFailedProviderSession(sessionId, input = {}) {
    const reference = await this.resolveSessionReference(sessionId);
    if (!reference?.providerId) throw new SessionNotFoundError(sessionId);
    return this.switchProvider(sessionId, {
      ...input,
      providerId: reference.providerId,
      expectedRoutingVersion: input.expectedRoutingVersion ?? reference.routingVersion,
      replaceFailedBinding: true
    });
  }

  async completeProviderSwitch(transitionId, targetProviderId, reference, logical) {
    const transition = this.store.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Provider transition ${transitionId} was not found.`);
    const resolvedTargetProviderId = targetProviderId
      ?? transition.targetProviderId
      ?? null;
    if (!resolvedTargetProviderId) {
      throw new Error(`Provider transition ${transitionId} has no target Provider.`);
    }
    if (transition.phase === "committed") {
      return this.finalizeCommittedProviderSwitch(transition, reference);
    }
    if (transition.phase === "failed") {
      throw new Error(`Provider transition ${transitionId} has already failed.`);
    }
    const sourceLogical = logical
      ?? this.store.getLogicalSession(transition.logicalSessionId);
    if (!sourceLogical?.activeBinding
      || sourceLogical.activeThreadId !== transition.sourceThreadId
      || sourceLogical.routingVersion !== transition.sourceRoutingVersion) {
      throw new Error("The source Provider route changed before the switch could continue.");
    }
    if (transition.phase === "forking" && !transition.newThreadId) {
      const error = providerSwitchRecoveryError(
        "Provider switch recovery could not uniquely identify the target session; the source route remains active.",
        "PROVIDER_SWITCH_TARGET_AMBIGUOUS"
      );
      this.failProviderSwitchTransition(transition, reference, resolvedTargetProviderId, error);
      throw error;
    }

    const context = await this.resolveTargetContext?.({
      reference,
      logical: sourceLogical,
      providerId: resolvedTargetProviderId,
      targetProviderId: resolvedTargetProviderId
    })
      ?? {};
    let created = null;
    let committedTransition = null;
    let committedLogical = null;
    try {
      const recoveringTarget = Boolean(transition.newThreadId);
      if (recoveringTarget) {
        created = await this.resumeProviderSwitchTarget({
          providerId: resolvedTargetProviderId,
          providerThreadId: transition.newThreadId,
          providerSessionId: transition.newThreadId,
          logicalSessionId: transition.logicalSessionId,
          transition,
          sourceLogical,
          context,
          dynamicTools: context.dynamicTools,
          dynamicToolConfirmation: transition.toolConfirmation ?? null,
          dynamicToolAgentId: context.dynamicToolAgentId,
          dynamicToolMetadata: context.dynamicToolMetadata
        });
      } else {
        this.store.updateWorkspaceTransition(transitionId, { phase: "forking" });
        created = await this.createTargetSession({
          providerId: resolvedTargetProviderId,
          title: sourceLogical.title || sourceLogical.sessionName,
          instructionSummary: context.instructionSummary ?? null,
          cwd: sourceLogical.activeBinding.boundCwd,
          agentId: context.agentId ?? null,
          sessionKind: context.sessionKind ?? reference?.metadata?.session?.sessionKind ?? "legacy",
          input: context.input ?? {},
          preparedToolHost: context.preparedToolHost,
          toolHostContext: context.toolHostContext,
          dynamicTools: context.dynamicTools,
          dynamicToolAgentId: context.dynamicToolAgentId,
          dynamicToolMetadata: context.dynamicToolMetadata
        });
      }
      assertTargetSessionInitialized(created, resolvedTargetProviderId);
      const createdThreadId = created?.providerThreadId
        ?? created?.external?.threadId
        ?? created?.external?.sessionId;
      const replacedUnrecoverableTarget = recoveringTarget
        && created?.replacedUnrecoverableTarget === true
        && created?.previousProviderThreadId === transition.newThreadId;
      const newThreadId = replacedUnrecoverableTarget
        ? createdThreadId
        : transition.newThreadId ?? createdThreadId;
      if (!newThreadId) {
        throw new Error(`Session Provider ${resolvedTargetProviderId} did not return a thread id.`);
      }
      if (!replacedUnrecoverableTarget && createdThreadId && createdThreadId !== newThreadId) {
        throw providerSwitchRecoveryError(
          "The recovered target Provider session did not match the persisted transition target.",
          "PROVIDER_SWITCH_TARGET_MISMATCH"
        );
      }
      const requiresAtomicTools = await this.requiresAtomicToolMaterialization({
        providerId: resolvedTargetProviderId,
        threadId: newThreadId,
        providerThreadId: newThreadId,
        providerSessionId: created?.providerSessionId ?? newThreadId,
        created,
        context,
        transition,
        sourceLogical
      });
      const dynamicTools = context.dynamicTools ?? created?.dynamicTools ?? null;
      const observedToolConfirmation = requiresAtomicTools
        ? await this.confirmTargetToolSchema({
            providerId: resolvedTargetProviderId,
            threadId: newThreadId,
            providerThreadId: newThreadId,
            providerSessionId: created?.providerSessionId ?? newThreadId,
            dynamicTools,
            dynamicToolAgentId: context.dynamicToolAgentId ?? null,
            dynamicToolMetadata: context.dynamicToolMetadata ?? null,
            created,
            context,
            transition,
            sourceLogical
          })
        : null;
      const toolConfirmation = recoveringTarget && requiresAtomicTools && !replacedUnrecoverableTarget
        ? requirePersistedToolConfirmation(transition.toolConfirmation, observedToolConfirmation)
        : observedToolConfirmation;
      this.store.updateWorkspaceTransition(transitionId, {
        phase: "committingRoute",
        newThreadId,
        toolConfirmation
      });
      const sessionProjection = created?.sessionProjection ?? created?.session ?? null;
      const newBindingId = `binding:${randomUUID()}`;
      const binding = {
        bindingId: newBindingId,
        providerThreadId: newThreadId,
        providerId: resolvedTargetProviderId,
        providerSessionId: created?.providerSessionId ?? newThreadId,
        logicalSessionId: transition.logicalSessionId,
        worktreeId: sourceLogical.activeBinding.worktreeId ?? null,
        repositoryId: sourceLogical.repositoryId ?? null,
        boundCwd: sourceLogical.activeBinding.boundCwd,
        routingVersion: transition.sourceRoutingVersion + 1,
        bindingGeneration: Number(sourceLogical.activeBinding.bindingGeneration ?? 1) + 1
      };
      const sourceToolMaterialization = sourceLogical.activeBinding.bindingId
        ? this.store.getSessionToolCatalogMaterialization(
            transition.logicalSessionId,
            sourceLogical.activeBinding.bindingId
          )
        : null;
      const preservesDesiredTools = requiresAtomicTools
        || sourceToolMaterialization != null
        || (Array.isArray(context.desiredToolDomains) && context.desiredToolDomains.length > 0);
      const toolMaterialization = preservesDesiredTools
        ? await this.prepareTargetToolMaterialization({
            transitionId,
            logicalSessionId: transition.logicalSessionId,
            sessionId: sourceLogical.legacySessionId ?? reference?.sessionId ?? null,
            sourceBinding: sourceLogical.activeBinding,
            binding,
            dynamicTools,
            dynamicToolConfirmation: toolConfirmation,
            dynamicToolAgentId: context.dynamicToolAgentId ?? null,
            dynamicToolMetadata: context.dynamicToolMetadata ?? null,
            created,
            context,
            transition,
            requiresApplied: requiresAtomicTools
          })
        : null;
      committedLogical = this.store.commitWorkspaceTransition(transitionId, {
        bindingId: newBindingId,
        providerThreadId: newThreadId,
        providerId: resolvedTargetProviderId,
        providerSessionId: created?.providerSessionId ?? newThreadId,
        boundCwd: sourceLogical.activeBinding.boundCwd,
        forkedAtTurnId: transition.lastCompletedTurnId,
        instructionSources: this.buildInstructionSources(sourceLogical, context),
        permissionSnapshot: providerPermissionSnapshot(sessionProjection),
        providerMetadata: {
          switchedFromProviderId: sourceLogical.activeBinding.providerId
        },
        sessionProjection,
        toolMaterialization
      });
      committedTransition = this.store.getWorkspaceTransition(transitionId);
      this.onTransitionEvent("ProviderSwitched", {
        sessionId: reference.sessionId,
        logicalSessionId: committedLogical.logicalSessionId,
        transitionId,
        fromProviderId: sourceLogical.activeBinding.providerId,
        toProviderId: resolvedTargetProviderId,
        bindingId: committedLogical.activeBinding?.bindingId ?? null,
        routingVersion: committedLogical.routingVersion
      });
    } catch (error) {
      const newThreadId = created?.providerThreadId
        ?? created?.external?.threadId
        ?? created?.external?.sessionId
        ?? transition.newThreadId;
      if (newThreadId) {
        this.store.recordProviderThreadBinding({
          providerThreadId: newThreadId,
          logicalSessionId: transition.logicalSessionId,
          boundCwd: sourceLogical.activeBinding.boundCwd,
          parentThreadId: transition.sourceThreadId,
          forkedAtTurnId: transition.lastCompletedTurnId,
          instructionSources: [],
          permissionSnapshot: sourceLogical.activeBinding.permissionSnapshot ?? {},
          providerId: resolvedTargetProviderId,
          providerSessionId: created?.providerSessionId ?? newThreadId,
          routingVersion: transition.sourceRoutingVersion + 1,
          state: "invalid"
        });
      }
      this.store.updateWorkspaceTransition(transitionId, {
        phase: "failed",
        newThreadId,
        error: { message: error.message }
      });
      this.onTransitionEvent("ProviderSwitchFailed", {
        sessionId: reference.sessionId,
        logicalSessionId: transition.logicalSessionId,
        transitionId,
        fromProviderId: sourceLogical.activeBinding.providerId,
        toProviderId: resolvedTargetProviderId,
        error: error.message
      });
      throw error;
    }

    return this.finalizeCommittedProviderSwitch(
      committedTransition,
      reference,
      committedLogical
    );
  }

  async finalizeCommittedProviderSwitch(transition, reference = null, logical = null) {
    const current = logical ?? this.store.getLogicalSession(transition.logicalSessionId);
    assertCommittedTargetBinding(transition, current);
    const binding = current.activeBinding;
    const materialization = binding.bindingId
      ? this.store.getSessionToolCatalogMaterialization(
          transition.logicalSessionId,
          binding.bindingId
        )
      : null;
    const result = {
      status: "committed",
      transition: this.store.getWorkspaceTransition(transition.transitionId) ?? transition,
      logicalSession: current
    };
    if (!materialization) {
      return { ...result, toolHostStatus: "ready" };
    }
    if (typeof this.finalizeCommittedTarget !== "function") {
      if (isCurrentAppliedMaterialization(materialization)) {
        return { ...result, toolHostStatus: "ready" };
      }
      return {
        ...result,
        toolHostStatus: "pending",
        toolHostErrorCode: "PROVIDER_TOOL_FINALIZATION_UNAVAILABLE",
        retryable: true
      };
    }

    try {
      await this.finalizeCommittedTarget({
        sessionId: current.legacySessionId ?? reference?.sessionId ?? null,
        logicalSessionId: current.logicalSessionId,
        providerId: binding.providerId,
        providerBindingId: binding.bindingId,
        providerSessionId: binding.providerSessionId,
        routingVersion: current.routingVersion,
        desiredToolDomains: desiredDomainIds(materialization),
        transitionId: transition.transitionId,
        purpose: "provider-switch-finalization"
      });
      const finalized = this.store.getLogicalSession(transition.logicalSessionId);
      assertCommittedTargetBinding(transition, finalized);
      const applied = this.store.getSessionToolCatalogMaterialization(
        transition.logicalSessionId,
        finalized.activeBinding.bindingId
      );
      if (!isCurrentAppliedMaterialization(applied)) {
        throw toolMaterializationError(
          "The committed Provider binding did not prove its Tool materialization."
        );
      }
      this.onTransitionEvent("ProviderSwitchToolsReady", {
        sessionId: finalized.legacySessionId ?? reference?.sessionId ?? null,
        logicalSessionId: finalized.logicalSessionId,
        transitionId: transition.transitionId,
        toProviderId: finalized.activeBinding.providerId,
        bindingId: finalized.activeBinding.bindingId,
        routingVersion: finalized.routingVersion
      });
      return {
        ...result,
        transition: this.store.getWorkspaceTransition(transition.transitionId) ?? transition,
        logicalSession: finalized,
        toolHostStatus: "ready"
      };
    } catch (error) {
      const errorCode = error?.code ?? "PROVIDER_TOOL_FINALIZATION_FAILED";
      this.onTransitionEvent("ProviderSwitchToolsPending", {
        sessionId: current.legacySessionId ?? reference?.sessionId ?? null,
        logicalSessionId: current.logicalSessionId,
        transitionId: transition.transitionId,
        toProviderId: binding.providerId,
        bindingId: binding.bindingId,
        routingVersion: current.routingVersion,
        errorCode
      });
      const latest = this.store.getLogicalSession(transition.logicalSessionId) ?? current;
      return {
        ...result,
        logicalSession: latest,
        toolHostStatus: "failed",
        toolHostErrorCode: errorCode,
        retryable: true
      };
    }
  }

  buildInstructionSources(logical, context) {
    const sources = [];
    const title = logical.title || logical.sessionName;
    if (title) {
      sources.push({ kind: "sessionTitle", title });
    }
    if (context.instructionSummary) {
      sources.push({ kind: "instructionSummary", summary: context.instructionSummary });
    }
    return sources;
  }

  async confirmTargetToolSchema(input) {
    if (!Array.isArray(input.dynamicTools)) {
      throw toolApplicationError(
        "The target Provider binding is missing the exact Tool definitions used to create its session."
      );
    }
    if (typeof this.confirmToolSchema !== "function") {
      throw toolApplicationError(
        "The target Provider did not expose an exact Tool schema confirmation boundary."
      );
    }
    const proof = await this.confirmToolSchema(input);
    return requireExactTargetToolConfirmation(
      input.providerThreadId,
      input.dynamicTools,
      proof
    );
  }

  async prepareTargetToolMaterialization(input) {
    if (typeof this.prepareToolMaterialization !== "function") {
      throw toolMaterializationError(
        "The target Provider did not expose an atomic Tool materialization boundary."
      );
    }
    const materialization = await this.prepareToolMaterialization(input);
    const allowedStatuses = input.requiresApplied === true ? ["applied"] : ["stale", "applied"];
    if (!materialization || !allowedStatuses.includes(materialization.status)) {
      throw toolMaterializationError(
        input.requiresApplied === true
          ? "The target Provider binding did not produce an applied Tool materialization."
          : "The target Provider binding did not preserve its authoritative desired Tool materialization."
      );
    }
    return materialization;
  }

  async resumeProviderSwitchTarget(input) {
    if (typeof this.resumeTargetSession !== "function") {
      throw providerSwitchRecoveryError(
        "The Provider switch target cannot be recovered safely; the source route remains active.",
        "PROVIDER_SWITCH_TARGET_RECOVERY_UNAVAILABLE"
      );
    }
    return this.resumeTargetSession(input);
  }

  failProviderSwitchTransition(transition, reference, targetProviderId, error) {
    this.store.updateWorkspaceTransition(transition.transitionId, {
      phase: "failed",
      newThreadId: transition.newThreadId ?? null,
      error: { message: error.message }
    });
    this.onTransitionEvent("ProviderSwitchFailed", {
      sessionId: reference?.sessionId ?? null,
      logicalSessionId: transition.logicalSessionId,
      transitionId: transition.transitionId,
      fromProviderId: this.store.getLogicalSession(transition.logicalSessionId)?.activeBinding?.providerId ?? null,
      toProviderId: targetProviderId,
      error: error.message
    });
  }
}

function assertCommittedRetryReference(transition, logical, reference) {
  assertCommittedTargetBinding(transition, logical);
  const binding = logical.activeBinding;
  if (binding.bindingId
    && binding.state === "active"
    && binding.logicalSessionId === logical.logicalSessionId
    && binding.providerThreadId === transition.newThreadId
    && binding.parentThreadId === transition.sourceThreadId
    && binding.routingVersion === logical.routingVersion
    && reference.logicalSessionId === logical.logicalSessionId
    && reference.sessionId === logical.legacySessionId
    && reference.bindingId === binding.bindingId
    && reference.providerId === binding.providerId
    && reference.providerSessionId === binding.providerSessionId
    && reference.routingVersion === logical.routingVersion) return;
  throw providerSwitchRecoveryError(
    "The committed Provider binding no longer matches the resolved Session route.",
    "SESSION_BINDING_CHANGED"
  );
}

function assertCommittedTargetBinding(transition, logical) {
  const expectedRoutingVersion = Number(transition.sourceRoutingVersion) + 1;
  const binding = logical?.activeBinding;
  const matches = binding
    && logical.activeThreadId === transition.newThreadId
    && binding.providerId === transition.targetProviderId
    && logical.routingVersion === expectedRoutingVersion;
  if (matches) return;
  const error = new Error("The committed Provider binding changed before Tool Host finalization completed.");
  error.code = "SESSION_BINDING_CHANGED";
  error.statusCode = 409;
  throw error;
}

function isCurrentAppliedMaterialization(materialization) {
  return materialization?.status === "applied"
    && typeof materialization.desiredVersion === "string"
    && materialization.desiredVersion.length > 0
    && materialization.appliedVersion === materialization.desiredVersion
    && materialization.appliedCatalogVersion === materialization.desiredCatalogVersion
    && materialization.providerReceipt != null;
}

function desiredDomainIds(materialization) {
  return [...new Set([
    ...(materialization?.desiredDomains ?? []),
    ...(materialization?.appliedDomains ?? [])
  ].map((domain) => (
    typeof domain === "string" ? domain.trim() : domain?.domainId?.trim()
  )).filter(Boolean).map((domainId) => (
    domainId === "work-item-acceptance" ? "task-acceptance" : domainId
  )))].sort();
}

function assertTargetSessionInitialized(created, providerId) {
  const session = created?.sessionProjection ?? created?.session ?? null;
  if (session?.status !== "failed") return;
  const detail = requiredText(
    session.sendUnavailableReason ?? session.summary ?? "Provider Session initialization failed.",
    "Provider initialization error"
  );
  const error = new Error(`Session Provider ${providerId} initialization failed: ${detail}`);
  error.code = "PROVIDER_SESSION_INITIALIZATION_FAILED";
  error.statusCode = 409;
  throw error;
}

function providerPermissionSnapshot(session) {
  const external = session?.external ?? {};
  return {
    ...(external.sandbox != null ? { sandbox: external.sandbox } : {}),
    ...(external.approvalPolicy != null ? { approvalPolicy: external.approvalPolicy } : {})
  };
}

function providerRequiresAtomicToolMaterialization(registry, providerId) {
  if (typeof registry?.get !== "function") return false;
  const provider = registry.get(providerId);
  return provider?.descriptor?.metadata?.toolSchemaCapabilities?.bindingReplacement === true;
}

function requireExactTargetToolConfirmation(threadId, definitions, value) {
  const proof = normalizeToolConfirmation(value);
  const expectedHash = hashToolDefinitions(definitions);
  const startRevision = proof?.providerRevision?.startsWith(`thread-start:${threadId}:`) === true;
  if (!proof
    || !startRevision
    || proof.providerDefinitionsHash !== expectedHash
    || proof.providerDefinitionsCount !== definitions.length
    || proof.providerObservationKind !== "thread_start_accepted") {
    throw toolApplicationError(
      "The target Provider Tool schema proof did not match its thread and exact Tool definitions."
    );
  }
  return {
    providerRevision: proof.providerRevision,
    providerDefinitionsHash: expectedHash,
    providerContractHash: toolDefinitionsContractHash(definitions),
    providerDefinitionsCount: definitions.length,
    providerObservationKind: "thread_start_accepted"
  };
}

function requirePersistedToolConfirmation(persisted, observed) {
  const expected = normalizeToolConfirmation(persisted);
  if (!expected
    || expected.providerRevision !== observed.providerRevision
    || expected.providerDefinitionsHash !== observed.providerDefinitionsHash
    || expected.providerDefinitionsCount !== observed.providerDefinitionsCount
    || expected.providerObservationKind !== observed.providerObservationKind) {
    throw toolApplicationError(
      "The recovered target Provider Tool proof did not match the persisted transition proof."
    );
  }
  return observed;
}

function normalizeToolConfirmation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    providerRevision: typeof value.providerRevision === "string"
      ? value.providerRevision.trim()
      : "",
    providerDefinitionsHash: typeof value.providerDefinitionsHash === "string"
      ? value.providerDefinitionsHash.trim()
      : "",
    providerContractHash: typeof value.providerContractHash === "string"
      ? value.providerContractHash.trim()
      : "",
    providerDefinitionsCount: value.providerDefinitionsCount == null
      ? null
      : Number(value.providerDefinitionsCount),
    providerObservationKind: typeof value.providerObservationKind === "string"
      ? value.providerObservationKind.trim()
      : ""
  };
}

function hashToolDefinitions(definitions) {
  return createHash("sha256")
    .update(stableToolDefinitions(definitions))
    .digest("hex");
}

function stableToolDefinitions(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableToolDefinitions).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableToolDefinitions(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolApplicationError(message) {
  const error = new Error(message);
  error.code = "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
  error.statusCode = 409;
  return error;
}

function toolMaterializationError(message) {
  const error = new Error(message);
  error.code = "PROVIDER_TOOL_MATERIALIZATION_REQUIRED";
  error.statusCode = 409;
  return error;
}

function providerSwitchRecoveryError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}
