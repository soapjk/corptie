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
  // Provider output timestamps can advance for every streamed chunk. Only the
  // durable user/final-assistant activity projection is a sorting signal.
  return { ...session, lastMessageAt: persistedMessageAt ?? null };
}

export function withSessionMessageCursors(session, cursors = null, timelineRevision = 0) {
  return {
    ...session,
    lastAgentMessageSequence: Number(cursors?.lastAgentMessageSequence ?? 0),
    lastReadMessageSequence: Number(cursors?.lastReadMessageSequence ?? 0),
    timelineRevision: Number(timelineRevision ?? 0)
  };
}
