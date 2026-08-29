import { randomUUID } from "node:crypto";
import { SessionNotFoundError } from "../agent-provider/sessionApplicationService.mjs";

// Provider-neutral coordinator for switching a logical Session from its current
// Session Provider to another one. It reuses the workspace_transitions state
// machine with transition_kind='provider' (fork strategy) so the existing
// routing_version optimistic-concurrency and in-flight-transition mutual
// exclusion apply unchanged. It is deliberately independent of any concrete
// Provider: the target session is created through the shared SESSION_CREATE
// capability, and the "title + instruction summary" context migration is the
// only content carried into the new thread (history is never deleted or
// replayed).
export class SessionProviderSwitchCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.registry = options.registry;
    this.resolveSessionReference = options.resolveSessionReference;
    this.createTargetSession = options.createTargetSession ?? null;
    this.resolveTargetContext = options.resolveTargetContext ?? null;
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
    if (input.expectedRoutingVersion != null
      && Number(input.expectedRoutingVersion) !== logical.routingVersion) {
      const error = new Error(`The Session route changed from version ${input.expectedRoutingVersion} to ${logical.routingVersion}.`);
      error.code = "STALE_SESSION_ROUTE";
      throw error;
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
      return {
        status: "committed",
        transition,
        logicalSession: this.store.getLogicalSession(transition.logicalSessionId)
      };
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

    const context = await this.resolveTargetContext?.({ reference, logical: sourceLogical })
      ?? {};
    let created = null;
    try {
      this.store.updateWorkspaceTransition(transitionId, { phase: "forking" });
      created = await this.createTargetSession({
        providerId: resolvedTargetProviderId,
        title: sourceLogical.title || sourceLogical.sessionName,
        instructionSummary: context.instructionSummary ?? null,
        cwd: sourceLogical.activeBinding.boundCwd,
        agentId: context.agentId ?? null,
        sessionKind: context.sessionKind ?? reference?.metadata?.session?.sessionKind ?? "legacy",
        input: context.input ?? {}
      });
      assertTargetSessionInitialized(created, resolvedTargetProviderId);
      const newThreadId = created?.providerThreadId
        ?? created?.external?.threadId
        ?? created?.external?.sessionId;
      if (!newThreadId) {
        throw new Error(`Session Provider ${resolvedTargetProviderId} did not return a thread id.`);
      }
      this.store.updateWorkspaceTransition(transitionId, {
        phase: "committingRoute",
        newThreadId
      });
      const sessionProjection = created?.sessionProjection ?? created?.session ?? null;
      const switched = this.store.commitWorkspaceTransition(transitionId, {
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
        sessionProjection
      });
      this.onTransitionEvent("ProviderSwitched", {
        sessionId: reference.sessionId,
        logicalSessionId: switched.logicalSessionId,
        transitionId,
        fromProviderId: sourceLogical.activeBinding.providerId,
        toProviderId: resolvedTargetProviderId,
        bindingId: switched.activeBinding?.bindingId ?? null,
        routingVersion: switched.routingVersion
      });
      return {
        status: "committed",
        transition: this.store.getWorkspaceTransition(transitionId),
        logicalSession: switched
      };
    } catch (error) {
      const newThreadId = created?.providerThreadId
        ?? created?.external?.threadId
        ?? created?.external?.sessionId;
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

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}
