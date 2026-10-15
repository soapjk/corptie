// Alias expansion exists only for legacy notification matching; the canonical
// V2 stream receives exactly one publish request for the original Session ID.
export function createTimelineChangeDispatcher({
  store, resolveSessionReference, invalidateDevices, publishDeviceTimeline, scheduleTimelineChange,
  publishQuickMessages = () => {}
}) {
  const commonRevision = () => {
    try { return store?.selectOne?.("SELECT common_revision FROM quick_message_build_v1 WHERE id=1")?.common_revision; }
    catch { return undefined; }
  };
  let lastCommonRevision = commonRevision();
  function resolveTimelineChangeSessionAliases(sessionId) {
    if (!sessionId || typeof sessionId !== "string") return [];
    const ids = new Set();
    ids.add(sessionId);

    const stripPrefix = (id) => id.replace(/^(codex|logical|session|pty):/, "");
    const stripped = stripPrefix(sessionId);
    if (stripped && stripped !== sessionId) {
      ids.add(stripped);
      ids.add(`session:${stripped}`);
      ids.add(`codex:${stripped}`);
      ids.add(`logical:${stripped}`);
    }

    try {
      const reference = resolveSessionReference(sessionId);
      if (reference) {
        if (reference.sessionId) {
          ids.add(reference.sessionId);
          const s = stripPrefix(reference.sessionId);
          ids.add(s);
          ids.add(`session:${s}`);
        }
        if (reference.logicalSessionId) {
          ids.add(reference.logicalSessionId);
          const s = stripPrefix(reference.logicalSessionId);
          ids.add(s);
          ids.add(`session:${s}`);
        }
        if (reference.requestedSessionId) {
          ids.add(reference.requestedSessionId);
        }
        const session = reference.metadata?.session ?? store?.getSession(reference.sessionId);
        if (session?.taskId) {
          ids.add(session.taskId);
          const s = stripPrefix(session.taskId);
          ids.add(s);
        }
      }
    } catch {}

    try {
      const logical = store?.getLogicalSession(sessionId) ?? store?.getLogicalSessionByLegacySessionId(sessionId);
      if (logical) {
        if (logical.logicalSessionId) ids.add(logical.logicalSessionId);
        if (logical.legacySessionId) ids.add(logical.legacySessionId);
      }
      const session = store?.getSession(sessionId);
      if (session?.taskId) ids.add(session.taskId);
    } catch {}

    return [...ids].filter(Boolean);
  }

  function scheduleTimelineChangePublish(change = {}) {
    const sessionIds = resolveTimelineChangeSessionAliases(change.sessionId);
    invalidateDevices({ sessionId: change.sessionId, sessionIds });
    // V2 streams receive every changed Session in the background. Use the
    // canonical source id once; aliases remain necessary only for legacy
    // notification matching.
    publishDeviceTimeline(change.sessionId);
    if (change.quickMessagesChanged) {
      const revision = commonRevision();
      const commonChanged = change.quickMessagesGlobalChanged || (revision !== undefined && revision !== lastCommonRevision);
      lastCommonRevision = revision;
      publishQuickMessages({ schemaVersion: 1, sessionId: change.sessionId,
        taskId: store?.getSession(change.sessionId)?.taskId ?? null,
        ...(commonChanged ? { commonChanged: true } : {}) });
    }
    scheduleTimelineChange(change);
  }

  return { scheduleTimelineChangePublish, resolveTimelineChangeSessionAliases };
}
