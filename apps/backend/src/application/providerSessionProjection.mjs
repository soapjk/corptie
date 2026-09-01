import {
  assertExplicitSessionKind,
  inferSessionKind,
  isProductSessionKind
} from "../utils/sessionKinds.mjs";

export function persistProviderSessionProjection(store, session, {
  providerId,
  agentId = null,
  sessionKind = null,
  objectiveId = null,
  taskId = null
} = {}) {
  if (!store?.db || !session?.id) return null;
  const suppliedSessionKind = sessionKind ?? session.sessionKind;
  if (suppliedSessionKind != null) {
    assertExplicitSessionKind(suppliedSessionKind, { allowLegacy: true });
  }
  const resolvedSessionKind = inferSessionKind({
    sessionKind: suppliedSessionKind,
    objectiveId: objectiveId ?? session.objectiveId,
    taskId: taskId ?? session.taskId
  });
  if (!isProductSessionKind(resolvedSessionKind)) {
    const error = new TypeError(`Provider Session ${session.id} has no valid product classification.`);
    error.code = "SESSION_CLASSIFICATION_REQUIRED";
    error.sessionId = session.id;
    throw error;
  }
  store.upsertSession({
    ...session,
    provider: providerId ?? session.external?.provider ?? "unknown",
    cwd: session.external?.cwd ?? null,
    command: session.external?.source ?? providerId ?? null,
    agentId: agentId ?? session.agentId ?? null,
    sessionKind: resolvedSessionKind,
    objectiveId: objectiveId ?? session.objectiveId ?? null,
    taskId: taskId ?? session.taskId ?? null
  });
  return store.getSession(session.id);
}

export function canonicalSessionIdFromEventPayload(payload = {}, {
  resolveStableSessionId = null
} = {}) {
  const rawSessionId = payload.session?.id ?? payload.sessionId ?? null;
  const providerId = payload.session?.external?.provider ?? payload.providerId ?? null;
  const providerSessionId = payload.session?.external?.sessionId
    ?? payload.providerSessionId
    ?? null;
  const threadId = payload.session?.external?.threadId ?? payload.threadId ?? null;
  const logicalSessionId = payload.session?.logicalSessionId
    ?? payload.session?.external?.logicalSessionId
    ?? payload.logicalSessionId
    ?? null;
  const resolved = typeof resolveStableSessionId === "function"
    ? resolveStableSessionId({
        rawSessionId,
        providerId,
        providerSessionId,
        threadId,
        logicalSessionId
      })
    : null;
  if (resolved) return String(resolved);
  if (rawSessionId) {
    const value = String(rawSessionId);
    // A namespaced ID is already a product/provider identity. Prefixing it
    // again produced invalid IDs such as codex:openclacky:… after a switch.
    if (value.includes(":")) return value;
    return providerId === "codex-app-server" ? `codex:${value}` : value;
  }
  return threadId ? `codex:${threadId}` : null;
}

// The sessions table contains only stable Corptie product identities. Provider
// threads and route history live in provider_thread_bindings and must never be
// inserted as repairable Session rows. Consequently list/snapshot reads are a
// pure O(n) projection with no per-row Binding or Logical Session queries.
export function visibleStoredSessionProjections(store, sessions = []) {
  void store;
  return sessions.filter((session) => isProductSessionKind(session?.sessionKind));
}

/// The resident client index is active-only. Archived Sessions remain durable
/// and are read through explicit archived endpoints until restoration makes
/// them active again.
export function activeStoredSessionProjections(store) {
  return visibleStoredSessionProjections(
    store,
    store.listSessions({ archived: false })
  );
}
