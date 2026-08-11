export function storedSessionIdForListSession(sessionId) {
  const id = String(sessionId ?? "");
  return id.startsWith("pty:") ? id.slice(4) : id;
}

export function applyPersistedSessionOrder(sessions = [], lookupStoredSession) {
  if (typeof lookupStoredSession !== "function") return sessions.slice();
  return sessions.map((session) => {
    const stored = lookupStoredSession(storedSessionIdForListSession(session?.id));
    if (!Number.isFinite(stored?.sortOrder)) return session;
    return {
      ...session,
      sortOrder: stored.sortOrder
    };
  });
}
