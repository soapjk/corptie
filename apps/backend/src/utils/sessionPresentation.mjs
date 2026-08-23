export function mergeStoredSessionPresentation(session, stored) {
  if (!stored) {
    return session;
  }
  const liveProvider = nonEmptyText(session.external?.provider);
  const storedProvider = nonEmptyText(stored.external?.provider);
  const liveProviderSessionId = providerSessionId(session);
  const storedProviderSessionId = providerSessionId(stored);
  const runtimeConfigurationMatches = (!liveProvider || !storedProvider || liveProvider === storedProvider)
    && (!liveProviderSessionId || !storedProviderSessionId || liveProviderSessionId === storedProviderSessionId);
  return {
    ...session,
    title: nonEmptyText(stored.title) || session.title,
    agentId: nonEmptyText(stored.agentId) || session.agentId || null,
    sessionKind: stored.sessionKind ?? session.sessionKind ?? "legacy",
    objectiveId: nonEmptyText(stored.objectiveId) || session.objectiveId || null,
    workItemId: nonEmptyText(stored.workItemId) || session.workItemId || null,
    archived: stored.archived,
    pinned: stored.pinned,
    sortOrder: stored.sortOrder,
    suggestedOptions: stored.suggestedOptions ?? session.suggestedOptions ?? null,
    external: {
      ...(session.external ?? {}),
      cwd: nonEmptyText(stored.external?.cwd) || session.external?.cwd,
      sandbox: runtimeConfigurationMatches
        ? (session.external?.sandbox ?? stored.external?.sandbox)
        : session.external?.sandbox,
      approvalPolicy: runtimeConfigurationMatches
        ? (session.external?.approvalPolicy ?? stored.external?.approvalPolicy)
        : session.external?.approvalPolicy,
      currentModel: runtimeConfigurationMatches
        ? (nonEmptyText(session.external?.currentModel) || stored.external?.currentModel || null)
        : (session.external?.currentModel || null),
      currentReasoningLevel: runtimeConfigurationMatches
        ? (nonEmptyText(session.external?.currentReasoningLevel) || stored.external?.currentReasoningLevel || null)
        : (session.external?.currentReasoningLevel || null)
    }
  };
}

// Session lists are a durable control-plane projection. Provider objects may
// be newer while an event is being persisted, but every runtime callback writes
// the sessions row synchronously before state sync runs. Once that write has
// committed, an older in-memory Provider object must never put a terminal row
// back into running. Keep the general merge above for Provider operations such
// as resume; use this stricter merge only at list/state-sync boundaries.
export function mergeAuthoritativeStoredSessionPresentation(session, stored) {
  const merged = mergeStoredSessionPresentation(session, stored);
  if (!stored) return merged;
  const status = stored.status ?? merged.status;
  const active = ["running", "blocked"].includes(status);
  return {
    ...merged,
    status,
    progress: stored.progress ?? merged.progress,
    summary: stored.summary ?? merged.summary,
    updatedAt: stored.updatedAt ?? merged.updatedAt,
    activityStatus: active
      ? (stored.activityStatus ?? session.activityStatus ?? null)
      : null,
    capabilities: stored.capabilities ?? merged.capabilities,
    rawStatus: stored.rawStatus ?? merged.rawStatus,
    external: {
      ...(merged.external ?? {}),
      activeTurnId: stored.external?.activeTurnId ?? null
    }
  };
}

function providerSessionId(session) {
  return nonEmptyText(session?.external?.sessionId) || nonEmptyText(session?.external?.threadId);
}

export function preferredSessionTitle(summary, detail) {
  return nonEmptyText(summary?.title)
    || nonEmptyText(detail?.title)
    || "Untitled session";
}

export function preferredSessionCwd(summary, detail) {
  return nonEmptyText(summary?.external?.cwd)
    || nonEmptyText(summary?.cwd)
    || nonEmptyText(detail?.cwd)
    || null;
}

export function reconcileAuthoritativeRunState(session, status) {
  if (!session || ["running", "blocked"].includes(status)) {
    return session;
  }
  return {
    ...session,
    external: {
      ...(session.external ?? {}),
      activeTurnId: null
    },
    rawStatus: session.rawStatus && typeof session.rawStatus === "object"
      ? { ...session.rawStatus, activeTurnId: null }
      : session.rawStatus
  };
}

export function sessionHasActiveRun(session) {
  const continuationState = session?.external?.workspace?.continuationState;
  const activeTurnId = session?.external?.activeTurnId || session?.rawStatus?.activeTurnId;
  // Workspace continuation state is orchestration state, not Provider runtime
  // state. In particular, a durable `running` value can survive a process
  // restart after its Provider turn has already stopped. Never let that
  // synthetic presentation keep the queue blocked without an active turn.
  if (["pending", "queued", "running"].includes(continuationState) && !activeTurnId) return false;
  return ["running", "blocked"].includes(session?.status)
    || Boolean(activeTurnId);
}

export function sessionNeedsAuthoritativeProjectionRecovery(session) {
  return (session?.external?.routingVersion ?? 1) > 1
    || sessionHasActiveRun(session);
}

export function activeSessionsDueForProjectionReconciliation(
  sessions = [],
  reconciledAt = new Map(),
  { now = Date.now(), minimumIntervalMs = 15_000 } = {}
) {
  return sessions.filter((session) => sessionHasActiveRun(session)
    && now - (reconciledAt.get(session.id) ?? 0) >= minimumIntervalMs);
}

// Recovery must observe both authorities. If another backend/process commits a
// terminal database projection while this process still has a stale running
// Provider cache (or vice versa), selecting candidates from only one side makes
// the disagreement permanent until the user opens the Session detail.
export function sessionProjectionRecoveryCandidates(
  persistedSessions = [],
  liveSessions = []
) {
  const byId = new Map();
  for (const session of persistedSessions) {
    if (!session?.id || !sessionHasActiveRun(session)) continue;
    byId.set(session.id, session);
  }
  // Live active rows replace durable active rows only for the Provider read
  // input; the resulting list projection remains database-authoritative.
  for (const session of liveSessions) {
    if (!session?.id || !sessionHasActiveRun(session)) continue;
    byId.set(session.id, session);
  }
  return [...byId.values()];
}

export async function reconcileSessionProjectionsIndependently(
  sessions = [],
  reconcile,
  { timeoutMs = 5_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  if (typeof reconcile !== "function") {
    throw new TypeError("reconcileSessionProjectionsIndependently requires reconcile().");
  }
  return Promise.all(sessions.map(async (session) => {
    let timer = null;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => reconcile(session)),
        new Promise((_, reject) => {
          timer = setTimer(() => {
            const error = new Error(`Session projection reconciliation timed out: ${session?.id ?? "unknown"}`);
            error.code = "SESSION_PROJECTION_RECONCILIATION_TIMEOUT";
            reject(error);
          }, timeoutMs);
        })
      ]);
      return { sessionId: session?.id ?? null, status: "fulfilled", value };
    } catch (error) {
      return {
        sessionId: session?.id ?? null,
        status: error?.code === "SESSION_PROJECTION_RECONCILIATION_TIMEOUT" ? "timedOut" : "rejected",
        error
      };
    } finally {
      if (timer != null) clearTimer(timer);
    }
  }));
}

export function applyWorkspaceContinuationPresentation(session, transition) {
  if (!session || !transition) return session;
  const state = transition.continuationState;
  if (["pending", "queued"].includes(state)) {
    return {
      ...session,
      status: "blocked",
      progress: Math.min(Number(session.progress) || 0, 0.5),
      activityStatus: "Queued to continue in the switched Worktree"
    };
  }
  if (state === "running") {
    const activeTurnId = session.external?.activeTurnId || session.rawStatus?.activeTurnId;
    if (!activeTurnId) {
      return {
        ...session,
        status: "blocked",
        progress: Math.min(Number(session.progress) || 0, 0.5),
        activityStatus: "Recovering continuation in the switched Worktree"
      };
    }
    return {
      ...session,
      status: "running",
      progress: Math.max(Number(session.progress) || 0, 0.5),
      activityStatus: session.activityStatus || "Continuing in the switched Worktree"
    };
  }
  if (state === "failed") {
    return {
      ...session,
      status: "failed",
      activityStatus: transition.continuationError || "Failed to continue after switching Worktrees"
    };
  }
  return session;
}

export function workspaceContinuationKeepsSessionActive(pendingTransition, committedTransition) {
  if (pendingTransition && !["committed", "failed"].includes(pendingTransition.phase)) return true;
  return ["pending", "queued", "running"].includes(committedTransition?.continuationState);
}

export function composeStoredSessionList({
  archived = false,
  ptySessions = [],
  claudeSessions = [],
  codexSessions = [],
  mockSessions = []
} = {}) {
  const candidates = [
    ...ptySessions,
    ...claudeSessions,
    ...codexSessions,
    ...(archived ? [] : mockSessions)
  ];
  return candidates
    .filter((session) => Boolean(session?.archived) === archived)
    .map((session) => ({
      ...session,
      sessionKind: session.sessionKind ?? "legacy"
    }));
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
