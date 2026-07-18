export function normalizeSessionTitle(title) {
  return String(title ?? "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function findSessionTitleConflict(sessions, title, excludingSessionId = null) {
  const key = normalizeSessionTitle(title);
  if (!key) return null;
  return (sessions ?? []).find((session) =>
    session?.id !== excludingSessionId && normalizeSessionTitle(session?.title) === key
  ) ?? null;
}

export function assertSessionTitleAvailable(sessions, title, excludingSessionId = null) {
  const conflict = findSessionTitleConflict(sessions, title, excludingSessionId);
  if (!conflict) return;
  const error = new Error(`A session named "${String(title).trim()}" already exists.`);
  error.code = "SESSION_TITLE_CONFLICT";
  error.statusCode = 409;
  error.conflictingSessionId = conflict.id;
  error.suggestedTitle = suggestAvailableSessionTitle(sessions, title, excludingSessionId);
  throw error;
}

export function suggestAvailableSessionTitle(sessions, title, excludingSessionId = null, additionalKeys = new Set()) {
  const base = String(title ?? "").trim() || "Agent";
  let suffix = 1;
  while (
    findSessionTitleConflict(sessions, `${base} ${suffix}`, excludingSessionId)
    || additionalKeys.has(normalizeSessionTitle(`${base} ${suffix}`))
  ) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

export function deduplicateSessionTitles(sessions) {
  const used = new Set();
  return (sessions ?? []).map((session) => {
    const base = String(session?.title ?? "").trim() || "Agent";
    let title = base;
    let suffix = 1;
    while (used.has(normalizeSessionTitle(title))) {
      title = `${base} ${suffix}`;
      suffix += 1;
    }
    used.add(normalizeSessionTitle(title));
    return title === session.title ? session : { ...session, title };
  });
}
