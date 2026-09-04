/**
 * Provider-neutral Session lifecycle operations.
 *
 * These four operations (execution preparation, recovery stabilization,
 * restart, and turn-change management) were originally written as Codex-only
 * server helpers. Their logic is product orchestration — workspace route
 * resolution, transition barriers, checkpoints, diff tooling — and applies
 * equally to every Provider that can bind a workspace and record file changes.
 *
 * Per AGENTS.md, product/business logic must not reach into a concrete
 * Provider adapter directly. Each operation here therefore takes the few
 * Provider-specific pieces it needs through the injected `adapters` map, keyed
 * by Provider id, and keeps all orchestration itself.
 */

const DEFAULT_RECOVERY_STABILIZE_TIMEOUT_MS = 90_000;

/**
 * Resolves the per-Provider adapter for one operation.
 *
 * A Provider that has not implemented an operation gets a typed
 * `CAPABILITY_NOT_IMPLEMENTED` error instead of a silent no-op, so the UI can
 * present an honest unavailable reason.
 */
function resolveAdapter(adapters, providerId, operation) {
  const adapter = adapters?.[providerId]?.[operation];
  if (typeof adapter === "function") return adapter;
  const error = new Error(
    `Provider ${providerId} does not implement ${operation}.`
  );
  error.code = "CAPABILITY_NOT_IMPLEMENTED";
  error.providerId = providerId;
  error.operation = operation;
  throw error;
}

export class ProviderSessionLifecycle {
  constructor(options = {}) {
    this.store = options.store;
    this.adapters = options.adapters ?? {};
    this.collaborationThreadOptionsForSession = options.collaborationThreadOptionsForSession;
    this.workspaceTransitionManager = options.workspaceTransitionManager;
    this.workspaceRoutePreparationCache = options.workspaceRoutePreparationCache;
    this.assertWorkspaceRouteUsable = options.assertWorkspaceRouteUsable;
    this.prepareExternalDiff = options.prepareExternalDiff;
    this.launchDiffTool = options.launchDiffTool;
    this.writeTurnPatch = options.writeTurnPatch;
    this.safeTurnFileChanges = options.safeTurnFileChanges;
    this.turnDiffFor = options.turnDiffFor;
    this.workspaceTransitionBlocksWork = options.workspaceTransitionBlocksWork;
    this.sessionHasActiveRun = options.sessionHasActiveRun;
    this.emitEvent = options.emitEvent ?? (() => {});
    this.now = options.now ?? (() => new Date().toISOString());

    const required = [
      "store", "collaborationThreadOptionsForSession", "workspaceTransitionManager",
      "workspaceRoutePreparationCache", "assertWorkspaceRouteUsable",
      "prepareExternalDiff", "launchDiffTool", "writeTurnPatch",
      "safeTurnFileChanges", "turnDiffFor", "workspaceTransitionBlocksWork",
      "sessionHasActiveRun"
    ];
    for (const key of required) {
      if (typeof this[key] !== "function" && typeof this[key] !== "object") {
        throw new TypeError(`ProviderSessionLifecycle requires ${key}.`);
      }
    }
  }

  /**
   * Brings a Session's Provider thread to an executable state.
   *
   * The Provider adapter supplies only the protocol-level "make this thread
   * ready" call plus permission normalisation; route resolution, transition
   * barriers and timing are owned here.
   */
  async prepareExecution(reference, context = {}) {
    const providerId = reference.providerId;
    const adapter = resolveAdapter(this.adapters, providerId, "ensureResumed");
    const startedAt = Date.now();
    const sessionId = reference.sessionId;
    const before = reference.metadata?.session ?? this.store.getSession(sessionId);
    if (!before) throw new Error("Session not found.");
    if (this.sessionHasActiveRun(before) && context.bindingReadinessProbe !== true) {
      return { prepared: true, alreadyActive: true, durationMs: Date.now() - startedAt };
    }
    const logicalRoute = this.store.getLogicalSessionByLegacySessionId(sessionId);
    if (this.workspaceTransitionBlocksWork(logicalRoute)) {
      const error = new Error("The Session is switching workspaces; execution preparation is deferred.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    const threadId = logicalRoute?.activeThreadId ?? reference.providerSessionId;
    const routeStartedAt = Date.now();
    const routeResolution = logicalRoute
      ? await this.#resolvePreparedWorkspaceRoute(logicalRoute, threadId)
      : null;
    const routeDurationMs = Date.now() - routeStartedAt;
    const managed = await adapter.normalizePermissions(
      this.#sessionWithLogicalWorkspace(this.store.getSession(sessionId) ?? before, logicalRoute)
    );
    const activeCwd = routeResolution?.route?.cwd
      ?? logicalRoute?.activeBinding?.boundCwd
      ?? managed.external?.cwd;
    const threadOptions = await adapter.threadOptions(reference, context);
    const resumeStartedAt = Date.now();
    // A freshly started thread may have no persisted rollout until its first
    // Turn. The adapter owns that protocol distinction: `ensureResumed` treats
    // a live fresh thread as ready while still issuing a real resume for
    // persisted bindings after a process restart. A readiness probe must not
    // bypass it.
    const resumeResult = await adapter.ensureResumed(threadId, {
      cwd: activeCwd,
      runtimeWorkspaceRoots: activeCwd ? [activeCwd] : undefined,
      ...threadOptions
    });
    const result = {
      prepared: true,
      sessionId: reference.logicalSessionId ?? sessionId,
      providerSessionId: threadId,
      routeCacheHit: routeResolution?.cacheHit === true,
      threadAlreadyLoaded: resumeResult?.alreadyLoaded === true,
      coalesced: resumeResult?.coalesced === true,
      routeDurationMs,
      resumeDurationMs: Date.now() - resumeStartedAt,
      durationMs: Date.now() - startedAt
    };
    console.info(`[session-execution-preparation] ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Re-attaches a Session during recovery with an exact Tool schema proof.
   *
   * Recovery is only safe when the caller proves the prospective Tool schema
   * matches what the Provider previously accepted, so a missing proof is a
   * hard failure rather than a best-effort resume.
   */
  async stabilizeRecoverySession(reference, context = {}) {
    const providerId = reference.providerId;
    if (!context.toolHost?.providerAttachment) {
      const error = new Error("Recovery stabilization requires the prospective Tool host attachment.");
      error.code = "RECOVERY_TOOL_CONFIRMATION_MISSING";
      throw error;
    }
    const adapter = resolveAdapter(this.adapters, providerId, "stabilizeRecovery");
    return adapter.stabilizeRecovery(reference, {
      cwd: context.boundCwd ?? reference.metadata?.session?.external?.cwd,
      ...context.toolHost.providerAttachment,
      timeoutMs: context.timeoutMs ?? DEFAULT_RECOVERY_STABILIZE_TIMEOUT_MS
    });
  }

  /**
   * Restarts a Session by re-binding its workspace route at a Turn boundary.
   *
   * Restart preserves the logical route and replays the Corptie-owned timeline
   * into a fresh Provider thread instead of resuming the old one.
   */
  async restartSession(reference, context = {}) {
    const sessionId = reference.sessionId;
    const session = reference.metadata?.session ?? this.store.getSession(sessionId);
    if (!session) throw new Error("Session not found.");
    const logical = (reference.logicalSessionId
      ? this.store.getLogicalSession(reference.logicalSessionId)
      : null) ?? await this.#ensureLogicalRoute(reference, session);
    if (!logical) {
      const error = new Error("The Session has no workspace route to restart.");
      error.code = "SESSION_ROUTE_UNAVAILABLE";
      throw error;
    }
    const checkpoint = this.#sessionTransitionCheckpoint(
      sessionId,
      logical.activeBinding?.bindingId
    );
    const preservingRecovery = context.preserveContext === true
      && context.replacementReason === "PROVIDER_TOOL_APPLICATION_UNCONFIRMED";
    const result = await this.workspaceTransitionManager.restartSession({
      transitionId: context.transitionId ?? `session-restart:${this.#randomUUID()}`,
      logicalSessionId: logical.logicalSessionId,
      activeTurnId: checkpoint.activeTurnId,
      lastCompletedTurnId: checkpoint.lastCompletedTurnId,
      ...await this.collaborationThreadOptionsForSession(sessionId, preservingRecovery
        ? { prospectiveBinding: true, purpose: "session-recovery" }
        : {})
    });
    this.emitEvent(
      result.status === "waitingForTurn" ? "SessionRestartWaiting" : "SessionRestartCompleted",
      { sessionId, logicalSessionId: logical.logicalSessionId, transition: result.transition },
      { sessionId }
    );
    return result;
  }

  /**
   * Reviews or reverts the file changes recorded for a single Turn.
   *
   * The Provider-neutral part is the route check, the change-set extraction
   * and the diff tooling. Only the item normalisation knows the Provider id,
   * because stored timeline text is normalised per Provider.
   */
  async manageTurnChanges(reference, turnId, action) {
    if (action !== "review" && action !== "undo") {
      throw new Error(`Unsupported turn changes action: ${action}`);
    }
    const threadId = reference.providerSessionId;
    const logicalRoute = this.store.getLogicalSessionByProviderThreadId(threadId);
    const activeRoute = logicalRoute
      ? await this.assertWorkspaceRouteUsable({
          store: this.store,
          logicalSession: logicalRoute,
          providerThreadId: threadId,
          allowHistorical: action === "review"
        })
      : null;
    const cwd = activeRoute?.cwd
      || reference.metadata?.session?.external?.cwd
      || this.store.getSession(reference.sessionId)?.external?.cwd;
    if (!cwd) throw new Error("The task working directory is unavailable.");

    const items = this.store.getFileChangeItemsForTurn(reference.sessionId, turnId, reference.providerId);
    const changes = this.safeTurnFileChanges(items, cwd);
    const diff = this.turnDiffFor(items, changes);
    if (action === "review") {
      const review = await this.prepareExternalDiff(cwd, threadId, turnId, changes, diff);
      const tool = await this.launchDiffTool(this.store.settings().codeDiff?.tool, review, changes);
      this.emitEvent("SessionTurnChangesReviewOpened", {
        sessionId: reference.sessionId,
        providerSessionId: threadId,
        turnId,
        tool,
        logicalSessionId: activeRoute?.logicalSessionId ?? reference.logicalSessionId ?? null,
        worktreeId: activeRoute?.worktreeId ?? null,
        routingVersion: activeRoute?.routingVersion ?? null
      }, { sessionId: reference.sessionId });
      return {
        ok: true,
        tool,
        logicalSessionId: activeRoute?.logicalSessionId ?? reference.logicalSessionId ?? null,
        providerSessionId: threadId,
        worktreeId: activeRoute?.worktreeId ?? null,
        routingVersion: activeRoute?.routingVersion ?? null,
        historical: activeRoute?.historical === true
      };
    }

    const { patchPath } = await this.writeTurnPatch(threadId, turnId, diff);
    await this.#reverseApplyPatch(patchPath, cwd);
    this.emitEvent("SessionTurnChangesUndone", {
      sessionId: reference.sessionId,
      providerSessionId: threadId,
      turnId,
      files: changes.map((change) => change.path),
      logicalSessionId: activeRoute?.logicalSessionId ?? reference.logicalSessionId ?? null,
      worktreeId: activeRoute?.worktreeId ?? null,
      routingVersion: activeRoute?.routingVersion ?? null
    }, { sessionId: reference.sessionId });
    return { ok: true, files: changes.map((change) => change.path) };
  }

  async #reverseApplyPatch(patchPath, cwd) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["apply", "--reverse", "--check", "--whitespace=nowarn", patchPath], { cwd });
    await execFileAsync("git", ["apply", "--reverse", "--whitespace=nowarn", patchPath], { cwd });
  }

  async #resolvePreparedWorkspaceRoute(logicalRoute, threadId) {
    return this.workspaceRoutePreparationCache.resolve({
      store: this.store,
      logicalSession: logicalRoute,
      providerThreadId: threadId,
      resolve: () => this.assertWorkspaceRouteUsable({
        store: this.store,
        logicalSession: logicalRoute,
        providerThreadId: threadId
      })
    });
  }

  #sessionTransitionCheckpoint(sessionId, bindingId = null) {
    const unsettled = this.store.listUnsettledSessionTurns(sessionId);
    const active = [...unsettled].reverse().find((turn) => !bindingId || turn.binding_id === bindingId)
      ?? unsettled.at(-1)
      ?? null;
    const completed = this.store.latestCompletedSessionTurn(sessionId, bindingId)
      ?? this.store.latestCompletedSessionTurn(sessionId);
    return {
      activeTurnId: active?.turn_id ?? null,
      lastCompletedTurnId: completed?.turn_id ?? null
    };
  }

  async #ensureLogicalRoute(reference, session) {
    const providerId = reference.providerId;
    const existing = this.store.getLogicalSessionByLegacySessionId(session.id);
    if (existing) return existing;
    const adapter = resolveAdapter(this.adapters, providerId, "ensureLogicalRoute");
    return adapter.ensureLogicalRoute(session, providerId);
  }

  #sessionWithLogicalWorkspace(session, logical) {
    if (!session || !logical) return session;
    const worktree = logical.activeWorkspaceId
      ? this.store.getGitWorktree(logical.activeWorkspaceId)
      : null;
    const cwd = worktree?.canonicalPath
      || worktree?.path
      || logical.activeBinding?.boundCwd
      || session.external?.cwd;
    return { ...session, external: { ...(session.external ?? {}), ...(cwd ? { cwd } : {}) } };
  }

  #randomUUID() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/**
 * Wraps a Codex-flavoured adapter into the neutral shape above.
 *
 * The existing server helpers already speak this protocol; this is the seam
 * that lets them be reused without `server.mjs` branching on the Provider id.
 */
export function codexLifecycleAdapter({
  runtime,
  ensureSessionPermissions,
  withPersistedToolConfirmation,
  collaborationThreadOptionsForSession,
  ensureLogicalRouteForCodexSession
}) {
  return {
    ensureResumed(threadId, options) {
      return runtime.ensureThreadResumed(threadId, options);
    },
    async normalizePermissions(session) {
      return ensureSessionPermissions(session);
    },
    async threadOptions(reference, context) {
      return withPersistedToolConfirmation(
        reference,
        context.toolHost?.providerAttachment
          ?? await collaborationThreadOptionsForSession(reference.sessionId)
      );
    },
    async stabilizeRecovery(reference, options) {
      if (!options.dynamicToolConfirmation) {
        const error = new Error("Codex recovery stabilization requires the exact prospective Tool schema proof.");
        error.code = "RECOVERY_TOOL_CONFIRMATION_MISSING";
        throw error;
      }
      return runtime.stabilizeRecoveryThread(reference.providerSessionId, options);
    },
    async ensureLogicalRoute(session) {
      return ensureLogicalRouteForCodexSession(session);
    }
  };
}
