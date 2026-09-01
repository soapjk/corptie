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
    taskId: nonEmptyText(stored.taskId) || session.taskId || null,
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
    .filter((session) => resolveSessionArchiveState(session, {
      taskStatus: session?.taskStatus
    }).archived === archived)
    .map((session) => {
      const archiveState = resolveSessionArchiveState(session, {
        taskStatus: session?.taskStatus
      });
      return {
        ...session,
        sessionKind: session.sessionKind ?? "legacy",
        archived: archiveState.archived,
        archiveReason: archiveState.reason
      };
    });
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
import { resolveSessionArchiveState } from "../domain/sessionArchivePolicy.mjs";
