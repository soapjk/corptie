import {
  assertSessionTitleAvailable, normalizeSessionTitle, resolveAvailableAgentSessionTitle,
  resolveAvailableSessionTitle, suggestAvailableSessionTitle
} from "../utils/sessionTitles.mjs";

// Pending creations share one reservation set; persisted title reads remain
// bounded to identity columns rather than full archived Session projections.
export function createSessionTitleReservations({ store }) {
  const reservedSessionTitleKeys = new Set();
  const knownSessionsForTitleValidation = () => store.listSessionTitleIdentities();

  function reserveSessionTitle(title, excludingSessionId = null) {
    const knownSessions = knownSessionsForTitleValidation();
    const logical = excludingSessionId
      ? (store.getLogicalSession(excludingSessionId) ?? store.getLogicalSessionByLegacySessionId(excludingSessionId))
      : null;
    const canonicalExclusion = logical?.legacySessionId ?? excludingSessionId;
    try {
      assertSessionTitleAvailable(knownSessions, title, canonicalExclusion);
    } catch (error) {
      error.suggestedTitle = suggestAvailableSessionTitle(
        knownSessions,
        title,
        canonicalExclusion,
        reservedSessionTitleKeys
      );
      throw error;
    }
    const key = normalizeSessionTitle(title);
    if (reservedSessionTitleKeys.has(key)) {
      const error = new Error(`A session named "${String(title).trim()}" is already being created.`);
      error.code = "SESSION_TITLE_CONFLICT";
      error.statusCode = 409;
      error.suggestedTitle = suggestAvailableSessionTitle(
        knownSessions,
        title,
        canonicalExclusion,
        reservedSessionTitleKeys
      );
      throw error;
    }
    reservedSessionTitleKeys.add(key);
    return () => reservedSessionTitleKeys.delete(key);
  }

  return {
    reserveSessionTitle,
    availableTitle: (baseTitle) => resolveAvailableSessionTitle(
      knownSessionsForTitleValidation(), baseTitle, null, reservedSessionTitleKeys
    ),
    availableAgentTitle: (name) => resolveAvailableAgentSessionTitle(
      knownSessionsForTitleValidation(), name, null, reservedSessionTitleKeys
    )
  };
}
