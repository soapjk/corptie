export function mergeStoredSessionPresentation(session, stored) {
  if (!stored) {
    return session;
  }
  return {
    ...session,
    title: nonEmptyText(stored.title) || session.title,
    agentId: nonEmptyText(stored.agentId) || session.agentId || null,
    sessionKind: stored.sessionKind ?? session.sessionKind ?? "legacy",
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
  return ["running", "blocked"].includes(session?.status)
    || Boolean(session?.external?.activeTurnId)
    || Boolean(session?.rawStatus?.activeTurnId);
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
