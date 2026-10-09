import { withCodexSessionPermissions } from "../utils/codexPermissions.mjs";

// Native command acknowledgements never infer turn progress; durable Provider
// events remain responsible for execution status.
export function createCodexSessionCommands({
  store, codexRuntime, now, codexAppServerSessionCapabilities, upsertManagedCodexSession,
  withPersistedCodexToolConfirmation, collaborationThreadOptionsForSession, invalidateWorkspaceRoute
}) {
  async function interruptCodexProviderSession(reference, context = {}) {
    const summary = context.summary ?? reference.metadata?.session;
    const activeTurnId = summary?.external?.activeTurnId ?? summary?.rawStatus?.activeTurnId ?? null;
    if (!activeTurnId) {
      const error = new Error("Session does not have an active turn to interrupt.");
      error.code = "NO_ACTIVE_RUN";
      throw error;
    }
    try {
      await codexRuntime.interruptTurn(reference.providerSessionId, activeTurnId);
    } catch (error) {
      // Narrow native protocol mapping, only for this exact interrupt request.
      // Transport failures and a missing local turn id are NOT absence evidence.
      let nativeError;
      try { nativeError = JSON.parse(error.message); } catch {}
      if (nativeError?.code === -32600 && nativeError.message === "no active turn to interrupt") {
        throw Object.assign(new Error("Provider confirmed no active turn for the interrupted Session."), {
          code: "PROVIDER_TURN_NOT_ACTIVE", turnId: activeTurnId,
          providerSessionId: reference.providerSessionId
        });
      }
      throw error;
    }
    // Command acknowledgement is not an execution-state event. The persisted
    // turn.cancelled Provider event owns the terminal Session projection.
    return store.getSession(reference.sessionId) ?? summary;
  }

  function updateCodexProviderConfiguration(reference, updates) {
    const sessionId = reference.sessionId;
    const threadId = reference.providerSessionId;
    const previous = store.getSession(sessionId);
    const timestamp = now();
    const session = previous ?? {
      id: sessionId,
      title: `Codex ${threadId.slice(0, 8)}`,
      agent: "Codex",
      status: "complete",
      progress: 1,
      summary: "Corptie-managed Codex task",
      capabilities: codexAppServerSessionCapabilities({ canInterrupt: false }),
      updatedAt: timestamp,
      accent: "cyan",
      external: { provider: "codex-app-server", threadId, source: "corptie" }
    };
    const nextSession = {
      ...session,
      updatedAt: timestamp,
      capabilities: {
        ...(session.capabilities ?? {}),
        canSwitchModel: true,
        canSwitchReasoning: true
      },
      external: {
        ...session.external,
        provider: "codex-app-server",
        threadId,
        ...updates
      }
    };
    upsertManagedCodexSession(nextSession);
    return nextSession;
  }

  function updateCodexProviderPermissions(reference, permissions) {
    const previous = reference.metadata?.session
      ?? store.getSession(reference.sessionId);
    if (!previous) {
      const error = new Error("Session not found.");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const session = withCodexSessionPermissions({
      ...previous,
      updatedAt: now()
    }, permissions);
    upsertManagedCodexSession(session);
    return session;
  }

  async function respondCodexProviderApproval(reference, input = {}, context = {}) {
    const summary = context.summary ?? reference.metadata?.session;
    const approved = input.approved === true;
    await codexRuntime.respondToApproval(reference.providerSessionId, {
      approved,
      optionId: input.optionId,
      itemId: input.itemId ?? input.choiceId
    });
    store.clearActiveChoicePrompt(reference.sessionId);
    // Do not guess that the Provider resumed. approval.resolved and subsequent
    // turn events own execution state; the command response is transport-only.
    return store.getSession(reference.sessionId) ?? summary;
  }

  async function respondCodexProviderUserInput(reference, input = {}, context = {}) {
    const summary = context.summary ?? reference.metadata?.session;
    await codexRuntime.respondToUserInput(reference.providerSessionId, {
      itemId: input.itemId,
      action: input.action,
      answers: input.answers
    });
    // The transport acknowledgement is not evidence that the Provider resumed.
    return store.getSession(reference.sessionId) ?? summary;
  }

  async function resumeCodexProviderSession(reference, context = {}) {
    const previous = reference.metadata?.session
      ?? store.getSession(reference.sessionId);
    if (!previous) throw new Error("Session not found.");
    const runtimeOptions = withPersistedCodexToolConfirmation(
      reference,
      context.toolHost?.providerAttachment
        ?? await collaborationThreadOptionsForSession(reference.sessionId)
    );
    if (context.purpose === "session-unarchive") {
      await codexRuntime.unarchiveThread(reference.providerSessionId);
    }
    if (context.purpose === "session-create-finalization") {
      // A newly started empty Codex thread has no rollout and cannot be resumed.
      // Its dynamic contracts were installed during thread/start; only their
      // trusted Session scope must be rebound after Corptie persists the route.
      codexRuntime.bindThreadToolContext(reference.providerSessionId, runtimeOptions);
    } else if (["session-recovery-validation", "provider-switch-recovery"].includes(context.purpose)) {
      // A replacement Codex thread is intentionally empty until the recovered
      // Delivery is dispatched. Fresh empty threads have no rollout file yet, so
      // thread/resume would falsely report them missing. ensureThreadResumed
      // validates the live app-server identity without creating a Turn.
      await codexRuntime.ensureThreadResumed(reference.providerSessionId, runtimeOptions);
    } else {
      await codexRuntime.resumeThread(reference.providerSessionId, runtimeOptions);
    }
    // Resume is a transport command. It must not project a Provider snapshot
    // back into Corptie's product Session or repair list state as a side effect.
    return previous;
  }

  async function probeCodexProviderBinding(reference, context = {}) {
    const logical = reference.logicalSessionId
      ? store.getLogicalSession(reference.logicalSessionId)
      : store.getLogicalSessionByLegacySessionId(reference.sessionId);
    const binding = logical?.activeBinding ?? null;
    if (!binding || binding.bindingId !== reference.bindingId) {
      const error = new Error("The Provider binding changed before its readiness probe.");
      error.code = "SESSION_BINDING_CHANGED";
      throw error;
    }
    const cwd = binding.boundCwd
      ?? reference.metadata?.session?.external?.cwd
      ?? null;
    const startedAt = Date.now();
    const result = await codexRuntime.ensureThreadResumed(reference.providerSessionId, {
      cwd: cwd ?? undefined,
      runtimeWorkspaceRoots: cwd ? [cwd] : undefined
    });
    return {
      ready: true,
      sessionId: reference.logicalSessionId ?? reference.sessionId,
      providerSessionId: reference.providerSessionId,
      threadAlreadyLoaded: result?.alreadyLoaded === true,
      durationMs: Date.now() - startedAt
    };
  }

  async function deleteCodexProviderSession(reference) {
    await codexRuntime.deleteThread(reference.providerSessionId);
    invalidateWorkspaceRoute(reference.logicalSessionId);
    // Product Session deletion belongs to SessionApplicationService's common
    // removeSessionBinding hook. Keeping it out of the concrete Adapter is also
    // essential for recovery rollback, whose unbound replacement reference uses
    // the stable legacy Session id and must never delete that Corptie projection.
    return true;
  }

  async function renameCodexProviderSession(reference, title) {
    const previous = reference.metadata?.session
      ?? store.getSession(reference.sessionId);
    if (!previous) throw new Error("Session not found.");
    await codexRuntime.setThreadName(reference.providerSessionId, title);
    const session = { ...previous, title, updatedAt: new Date().toISOString() };
    upsertManagedCodexSession(session);
    return session;
  }

  async function readCodexProviderAccountUsage(reference = null) {
    const usage = await codexRuntime.readAccountRateLimits();
    return {
      available: true,
      provider: "codex",
      model: reference?.metadata?.session?.external?.currentModel ?? null,
      ...usage
    };
  }

  async function readCodexProviderSessionUsage(reference) {
    const threadId = reference?.providerSessionId;
    if (!threadId) return null;
    const live = codexRuntime.tokenUsageForThread(threadId);
    return live ?? null;
  }

  return {
    resumeCodexProviderSession, probeCodexProviderBinding, deleteCodexProviderSession, renameCodexProviderSession, readCodexProviderAccountUsage, readCodexProviderSessionUsage,
    interruptCodexProviderSession, updateCodexProviderConfiguration,
    updateCodexProviderPermissions, respondCodexProviderApproval, respondCodexProviderUserInput
  };
}
