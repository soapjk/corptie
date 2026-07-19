export function mergeStoredSessionPresentation(session, stored) {
  if (!stored) {
    return session;
  }
  return {
    ...session,
    title: nonEmptyText(stored.title) || session.title,
    archived: stored.archived,
    pinned: stored.pinned,
    sortOrder: stored.sortOrder,
    avatarPath: stored.avatarPath ?? session.avatarPath ?? null,
    suggestedOptions: stored.suggestedOptions ?? session.suggestedOptions ?? null,
    external: {
      ...(session.external ?? {}),
      sandbox: stored.external?.sandbox ?? session.external?.sandbox,
      approvalPolicy: stored.external?.approvalPolicy ?? session.external?.approvalPolicy
    }
  };
}

export function preferredSessionTitle(summary, detail) {
  return nonEmptyText(summary?.title)
    || nonEmptyText(detail?.title)
    || "Untitled session";
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
  return [
    ...ptySessions,
    ...claudeSessions,
    ...codexSessions,
    ...(archived ? [] : mockSessions)
  ];
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
