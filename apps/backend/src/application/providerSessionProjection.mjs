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
    sessionKind: workItem ? "worker" : (boundAgent?.role === "assistant" ? "assistantChat" : "legacy")
  });
  if (workItem) {
    store.bindSessionToWorkItem(session.id, workItem.id, workItem.objective_id);
  }
  if (agentId && !boundAgent) bindAgentToSession({ agentId, sessionId: session.id });
  return { session: store.getSession(session.id), repaired: true };
}
