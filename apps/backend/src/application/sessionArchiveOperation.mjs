import { assertManualSessionArchiveAllowed } from "../domain/sessionArchivePolicy.mjs";

export async function archiveStoredSession(rawId, archived, {
  store, sessionRuntimeReleaseService, normalizeSessionId, legacyArchiveFor
}) {
  const storedSession = store.getSession(rawId);
  if (!storedSession) return null;
  assertManualSessionArchiveAllowed(storedSession);
  const legacyArchive = legacyArchiveFor(rawId);
  if (legacyArchive) {
    const session = { ...storedSession, archived, updatedAt: new Date().toISOString() };
    if (archived) {
      store.archiveSession(rawId, true);
      void sessionRuntimeReleaseService.request(rawId, "manual-archive");
    } else {
      sessionRuntimeReleaseService.cancelPending(rawId);
      legacyArchive.upsert(session);
      await sessionRuntimeReleaseService.restore(rawId);
    }
    return session;
  }
  const session = store.archiveSession(normalizeSessionId(rawId), archived);
  if (!session) return null;
  if (archived) void sessionRuntimeReleaseService.request(session.id, "manual-archive");
  else await sessionRuntimeReleaseService.restore(session.id);
  return session;
}
