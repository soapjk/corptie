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
    suggestedOptions: stored.suggestedOptions ?? session.suggestedOptions ?? null
  };
}

export function preferredSessionTitle(summary, detail) {
  return nonEmptyText(summary?.title)
    || nonEmptyText(detail?.title)
    || "Untitled session";
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
