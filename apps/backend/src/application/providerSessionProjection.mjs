export function persistProviderSessionProjection(store, session, {
  providerId,
  agentId = null,
  sessionKind = null
} = {}) {
  if (!store?.db || !session?.id) return null;
  store.upsertSession({
    ...session,
    provider: providerId ?? session.external?.provider ?? "unknown",
    cwd: session.external?.cwd ?? null,
    command: session.external?.source ?? providerId ?? null,
    agentId: agentId ?? session.agentId ?? null,
    sessionKind: sessionKind ?? session.sessionKind ?? "legacy"
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
    updatedAt: stable.updatedAt,
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
