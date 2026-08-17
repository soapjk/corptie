export function mergeStoredSessionPresentation(session, stored) {
  if (!stored) {
    return session;
  }
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
      sandbox: stored.external?.sandbox ?? session.external?.sandbox,
      approvalPolicy: stored.external?.approvalPolicy ?? session.external?.approvalPolicy,
      currentModel: nonEmptyText(stored.external?.currentModel) || session.external?.currentModel || null,
      currentReasoningLevel: nonEmptyText(stored.external?.currentReasoningLevel)
        || session.external?.currentReasoningLevel
        || null
    }
  };
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
  if (["pending", "queued"].includes(continuationState) && !activeTurnId) return false;
  return ["running", "blocked"].includes(session?.status)
    || Boolean(activeTurnId);
}

export function applyWorkspaceContinuationPresentation(session, transition) {
  if (!session || !transition) return session;
  const state = transition.continuationState;
  if (["pending", "queued"].includes(state)) {
    return {
      ...session,
      status: "running",
      progress: Math.min(Number(session.progress) || 0, 0.5),
      activityStatus: "Waiting to continue in the switched Worktree"
    };
  }
  if (state === "running") {
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
