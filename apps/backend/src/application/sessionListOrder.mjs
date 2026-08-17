import { mergeStoredSessionPresentation } from "../utils/sessionPresentation.mjs";

export function storedSessionIdForListSession(sessionId) {
  const id = String(sessionId ?? "");
  return id.startsWith("pty:") ? id.slice(4) : id;
}

export function applyPersistedSessionOrder(sessions = [], lookupStoredSession) {
  if (typeof lookupStoredSession !== "function") return sessions.slice();
  return sessions.map((session) => {
    const stored = lookupStoredSession(storedSessionIdForListSession(session?.id));
    if (!stored) return session;
    return mergeStoredSessionPresentation(session, stored);
  });
}
