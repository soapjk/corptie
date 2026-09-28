export function sortSessionsForList(sessions = []) {
  return sessions.slice().sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1;
    }
    const aOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
  });
}

export function withLastMessageTimestamp(session, persistedMessageAt = null) {
  const candidates = [
    session.lastMessageAt,
    session.lastInputAt,
    session.lastOutputAt,
    session.rawStatus?.lastMessageAt,
    session.rawStatus?.lastInputAt,
    session.rawStatus?.lastOutputAt,
    persistedMessageAt
  ].filter((value) => typeof value === "string" && value.trim());
  const lastMessageAt = candidates.sort((a, b) => b.localeCompare(a))[0] ?? null;
  return { ...session, lastMessageAt };
}

export function withSessionMessageCursors(session, cursors = null, timelineRevision = 0) {
  return {
    ...session,
    lastAgentMessageSequence: Number(cursors?.lastAgentMessageSequence ?? 0),
    lastReadMessageSequence: Number(cursors?.lastReadMessageSequence ?? 0),
    timelineRevision: Number(timelineRevision ?? 0)
  };
}
