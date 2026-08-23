export function persistProviderSessionProjection(store, session, {
  providerId,
  agentId = null,
  sessionKind = null,
  objectiveId = null,
  workItemId = null
} = {}) {
  if (!store?.db || !session?.id) return null;
  store.upsertSession({
    ...session,
    provider: providerId ?? session.external?.provider ?? "unknown",
    cwd: session.external?.cwd ?? null,
    command: session.external?.source ?? providerId ?? null,
    agentId: agentId ?? session.agentId ?? null,
    sessionKind: sessionKind ?? session.sessionKind ?? "legacy",
    objectiveId: objectiveId ?? session.objectiveId ?? null,
    workItemId: workItemId ?? session.workItemId ?? null
  });
  return store.getSession(session.id);
}

// Resolve a physical Provider Session against the durable logical route before
// the generic projection repair runs. The active target thread keeps the
// original public Session identity; superseded/invalid physical threads are
// historical implementation details and must not reappear as duplicate rows.
export function resolveRoutedProviderSessionProjection(store, session, {
  providerId = session?.external?.provider ?? null
} = {}) {
  if (!store?.db || !session?.id || !providerId) {
    return { disposition: "unbound", session, logical: null };
  }
  const providerSessionId = session.external?.sessionId
    ?? session.external?.threadId
    ?? session.id;
  const logical = store.getLogicalSessionByProviderSessionId(providerId, providerSessionId);
  if (logical?.activeBinding) {
    const stable = store.getSession(logical.legacySessionId);
    return {
      disposition: "active",
      logical,
      session: {
        ...session,
        id: logical.legacySessionId,
        title: logical.sessionName || logical.title || stable?.title || session.title,
        sessionName: logical.sessionName || logical.title || stable?.title || session.sessionName || session.title,
        agent: stable?.agent ?? session.agent,
        agentId: stable?.agentId ?? session.agentId ?? null,
        sessionKind: stable?.sessionKind ?? session.sessionKind ?? "legacy",
        objectiveId: stable?.objectiveId ?? session.objectiveId ?? null,
        workItemId: stable?.workItemId ?? session.workItemId ?? null,
        archived: stable?.archived ?? session.archived,
        pinned: stable?.pinned ?? session.pinned,
        sortOrder: stable?.sortOrder ?? session.sortOrder,
        external: {
          ...(session.external ?? {}),
          provider: logical.activeBinding.providerId,
          threadId: logical.activeThreadId,
          sessionId: logical.activeBinding.providerSessionId
        }
      }
    };
  }

  const providerThreadId = session.external?.threadId ?? providerSessionId;
  const binding = store.getProviderThreadBinding(providerThreadId);
  if (binding && binding.state !== "active") {
    return { disposition: "historical", session: null, logical: null };
  }
  return { disposition: "unbound", session, logical: null };
}

export function isBoundPhysicalProviderSession(store, session) {
  if (!store?.db || !session?.id) return false;
  const providerId = session.external?.provider;
  const providerSessionId = session.external?.sessionId ?? session.external?.threadId;
  if (!providerId || !providerSessionId) return false;
  const logical = store.getLogicalSessionByProviderSessionId(providerId, providerSessionId);
  return Boolean(logical && logical.legacySessionId !== session.id);
}

// Provider runtimes may persist their newly-created physical thread before the
// stable Session projection is refreshed. Those rows are implementation
// details of an existing logical Session, never independent product Sessions.
// Keep this rule at the projection boundary so snapshots and incremental state
// sync expose exactly one identity with its original kind/entity ownership.
export function visibleStoredSessionProjections(store, sessions = []) {
  return sessions.filter((session) => !isBoundPhysicalProviderSession(store, session));
}

export function repairStableSessionFromBoundPhysicalProjection(store, session) {
  if (!isBoundPhysicalProviderSession(store, session)) return null;
  const providerId = session.external.provider;
  const providerSessionId = session.external.sessionId ?? session.external.threadId;
  const logical = store.getLogicalSessionByProviderSessionId(providerId, providerSessionId);
  const stable = store.getSession(logical.legacySessionId);
  if (!stable) return null;
  store.upsertSession({
    ...session,
    id: stable.id,
    title: logical.sessionName || logical.title || stable.title,
    agent: stable.agent,
    agentId: stable.agentId,
    sessionKind: stable.sessionKind,
    objectiveId: stable.objectiveId,
    workItemId: stable.workItemId,
    archived: stable.archived,
    pinned: stable.pinned,
    sortOrder: stable.sortOrder,
    createdAt: stable.createdAt,
    updatedAt: session.updatedAt ?? stable.updatedAt,
    external: {
      ...(session.external ?? {}),
      provider: logical.activeBinding.providerId,
      threadId: logical.activeThreadId,
      sessionId: logical.activeBinding.providerSessionId,
      logicalSessionId: logical.logicalSessionId,
      routingVersion: logical.routingVersion
    }
  });
  return store.getSession(stable.id);
}

// A newly-created Provider thread can finish its bootstrap turn before the
// logical route switch is committed. In that window its freshest projection is
// cached under the physical Provider identity. Once the route is active, copy
// that projection back onto the stable product Session immediately so the UI
// never remains stuck on the initial "Starting …" projection.
export function repairStableSessionFromActiveProviderCache(store, logicalSessionId, sessions = []) {
  if (!store?.db || !logicalSessionId) return null;
  const logical = store.getLogicalSession(logicalSessionId);
  if (!logical?.activeBinding) return null;
  const activeProviderId = logical.activeBinding.providerId;
  const activeProviderSessionId = logical.activeBinding.providerSessionId;
  const activeThreadId = logical.activeThreadId;
  const physical = sessions.find((session) => {
    if (!session || session.id === logical.legacySessionId) return false;
    const external = session.external ?? {};
    return external.provider === activeProviderId
      && (external.sessionId === activeProviderSessionId || external.threadId === activeThreadId);
  });
  return physical ? repairStableSessionFromBoundPhysicalProjection(store, physical) : null;
}

// Repairs the historical state where a Corptie-owned Provider session had a
// logical route / entity links but no row in the shared sessions projection.
export function ensureProviderSessionProjection({
  store,
  session,
  resolveAgentForSession = () => null,
  bindAgentToSession = () => null
} = {}) {
  if (!store?.db || !session?.id) return { session: null, repaired: false };
  const existing = store.getSession(session.id);
  const workItem = store.getWorkItemBySessionId(session.id);
  const boundAgent = resolveAgentForSession(session.id);
  const agentId = boundAgent?.agentId ?? workItem?.main_agent_id ?? existing?.agentId ?? null;
  if (existing) {
    const bindingRepaired = Boolean(agentId && !boundAgent);
    if (bindingRepaired) bindAgentToSession({ agentId, sessionId: session.id });
    return { session: existing, repaired: bindingRepaired };
  }

  persistProviderSessionProjection(store, session, {
    providerId: session.external?.provider,
    agentId,
    sessionKind: workItem ? "worker" : (session.objectiveId ? "objectiveChat" : (boundAgent?.role === "assistant" ? "assistantChat" : "legacy"))
  });
  if (workItem) {
    store.bindSessionToWorkItem(session.id, workItem.id, workItem.objective_id);
  }
  if (agentId && !boundAgent) bindAgentToSession({ agentId, sessionId: session.id });
  return { session: store.getSession(session.id), repaired: true };
}
