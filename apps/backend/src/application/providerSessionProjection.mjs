import {
  assertExplicitSessionKind,
  inferSessionKind,
  isProductSessionKind
} from "../utils/sessionKinds.mjs";

export function persistProviderSessionProjection(store, session, {
  providerId,
  agentId = null,
  sessionKind = null
} = {}) {
  if (!store?.db || !session?.id) return null;
  const suppliedSessionKind = sessionKind ?? session.sessionKind;
  if (suppliedSessionKind != null) {
    assertExplicitSessionKind(suppliedSessionKind, { allowLegacy: true });
  }
  const resolvedSessionKind = inferSessionKind({
    sessionKind: suppliedSessionKind,
    objectiveId: session.objectiveId,
    workItemId: session.workItemId
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
    sessionKind: resolvedSessionKind
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
  const binding = store.getAgentSessionBindingByProviderSession(providerId, providerSessionId);
  const logical = binding ? store.getLogicalSession(binding.logicalSessionId) : null;
  return Boolean(logical && logical.legacySessionId !== session.id);
}

// Provider runtimes may persist their newly-created physical thread before the
// stable Session projection is refreshed. Those rows are implementation
// details of an existing logical Session, never independent product Sessions.
// Keep this rule at the projection boundary so snapshots and incremental state
// sync expose exactly one identity with its original kind/entity ownership.
export function visibleStoredSessionProjections(store, sessions = []) {
  return sessions.filter((session) => isProductSessionKind(session?.sessionKind)
    && !isBoundPhysicalProviderSession(store, session));
}

// Remove only obsolete physical rows that are provably represented by another
// canonical logical Session. Provider routing history remains intact. Rows with
// user content or business references are retained (but hidden) for audit.
export function purgeObsoleteUnclassifiedProviderProjections(store) {
  if (!store?.db) return { purged: [], retained: [] };
  const rows = store.selectAll(
    `SELECT id FROM sessions
     WHERE session_kind IS NULL OR TRIM(session_kind) = ''
        OR session_kind NOT IN ('assistantChat', 'objectiveChat', 'worker')`
  );
  const purged = [];
  const retained = [];
  for (const row of rows) {
    const session = store.getSession(row.id);
    const providerId = session?.external?.provider;
    const providerSessionId = session?.external?.sessionId ?? session?.external?.threadId;
    const binding = providerId && providerSessionId
      ? store.getAgentSessionBindingByProviderSession(providerId, providerSessionId)
      : null;
    const logical = binding ? store.getLogicalSession(binding.logicalSessionId) : null;
    const canonical = logical?.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    const references = store.selectOne(
      `SELECT
         (SELECT COUNT(*) FROM session_events WHERE session_id = ?) AS events,
         (SELECT COUNT(*) FROM session_items WHERE session_id = ? AND type <> 'warning') AS meaningful_items,
         (SELECT COUNT(*) FROM session_context_references WHERE owner_session_id = ?) AS context_refs,
         (SELECT COUNT(*) FROM collaboration_tasks
            WHERE initiator_session_id = ? OR recipient_session_id = ?) AS collaboration_tasks,
         (SELECT COUNT(*) FROM collaboration_messages
            WHERE sender_session_id = ? OR recipient_session_id = ?) AS collaboration_messages,
         (SELECT COUNT(*) FROM work_items
            WHERE current_session_id = ? OR created_by_session_id = ?) AS work_items`,
      [row.id, row.id, row.id, row.id, row.id, row.id, row.id, row.id, row.id]
    );
    const referenceCount = Object.values(references ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
    const safeObsoleteProjection = binding?.state !== "active"
      && logical
      && canonical
      && canonical.id !== row.id
      && isProductSessionKind(canonical.sessionKind)
      && referenceCount === 0;
    if (!safeObsoleteProjection) {
      retained.push({
        sessionId: row.id,
        reason: referenceCount > 0 ? "has_user_or_business_references" : "not_a_redundant_historical_projection"
      });
      continue;
    }
    const removedWarningItems = Number(store.selectOne(
      "SELECT COUNT(*) AS count FROM session_items WHERE session_id = ? AND type = 'warning'",
      [row.id]
    )?.count ?? 0);
    store.deleteSession(row.id);
    purged.push({
      sessionId: row.id,
      canonicalSessionId: canonical.id,
      logicalSessionId: logical.logicalSessionId,
      removedWarningItems
    });
  }
  return { purged, retained };
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
    return {
      session: existing,
      repaired: bindingRepaired,
      visible: isProductSessionKind(existing.sessionKind),
      reason: isProductSessionKind(existing.sessionKind) ? null : "unclassified_existing_projection"
    };
  }

  let suppliedSessionKind = session.sessionKind;
  if (suppliedSessionKind != null) {
    try {
      suppliedSessionKind = assertExplicitSessionKind(suppliedSessionKind, { allowLegacy: true });
    } catch {
      return {
        session: null,
        repaired: false,
        visible: false,
        reason: "invalid_provider_session_kind"
      };
    }
  }
  const sessionKind = inferSessionKind({
    sessionKind: suppliedSessionKind,
    objectiveId: session.objectiveId,
    workItemId: workItem?.id ?? session.workItemId,
    agentRole: boundAgent?.role
  });
  if (!isProductSessionKind(sessionKind)) {
    return {
      session: null,
      repaired: false,
      visible: false,
      reason: "unclassified_unowned_provider_session"
    };
  }
  persistProviderSessionProjection(store, session, {
    providerId: session.external?.provider,
    agentId,
    sessionKind
  });
  if (workItem) {
    store.bindSessionToWorkItem(session.id, workItem.id, workItem.objective_id);
  }
  if (agentId && !boundAgent) bindAgentToSession({ agentId, sessionId: session.id });
  return { session: store.getSession(session.id), repaired: true, visible: true, reason: null };
}
