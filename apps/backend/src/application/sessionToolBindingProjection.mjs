// Provider-neutral Session identity and Tool Host authorization projection.
// Reads authoritative bindings on each call; never caches a second route.
export function createSessionToolBindingProjection({ store, prepareDesiredReplacement }) {
  function sessionToolMetadata(session) {
    const logical = session?.id
      ? store.getLogicalSessionByLegacySessionId(session.id)
      : null;
    return {
      purpose: "session",
      sessionKind: session?.sessionKind ?? "legacy",
      workId: session?.workId ?? null,
      taskId: session?.taskId ?? null,
      sessionId: session?.id ?? null,
      logicalSessionId: logical?.logicalSessionId ?? session?.external?.logicalSessionId ?? null,
      providerBindingId: logical?.activeBinding?.bindingId ?? null,
      providerId: logical?.activeBinding?.providerId ?? null
    };
  }

  function resolveDynamicToolCallMetadata(params = {}) {
    const logical = params.threadId
      ? store.getLogicalSessionByProviderThreadId(params.threadId)
      : null;
    const session = logical?.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    return session ? sessionToolMetadata(session) : (params.metadata ?? null);
  }

  function resolveToolHostBinding(logicalSessionId, providerBindingId) {
    const logical = store.getLogicalSession(logicalSessionId);
    const active = logical?.activeBinding ?? null;
    if (!logical || !active || active.bindingId !== providerBindingId) return null;
    const session = logical.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    const task = session?.taskId ? store.getTask(session.taskId) : null;
    const startupAuthorization = session?.sessionKind === "worker" && task?.current_session_id !== session.id
      ? (store.selectOne(
        `SELECT startup.startup_operation_id, startup.resource_version
         FROM work_session_startup_operations startup
         JOIN work_session_startup_bindings binding
           ON binding.startup_operation_id=startup.startup_operation_id
         WHERE startup.task_id=? AND startup.legacy_session_id=? AND startup.logical_session_id=?
           AND startup.provider_id=? AND startup.state IN ('session_bound','provider_bound')
           AND binding.provider_resource_id=? AND binding.status='binding'
        ORDER BY startup.allocated_at DESC LIMIT 1`,
        [session.taskId, session.id, logical.logicalSessionId, active.providerId, active.providerSessionId]
      ) ?? store.selectOne(
        `SELECT execution.execution_space_id AS startup_operation_id, execution.resource_version
         FROM execution_spaces execution
         WHERE execution.task_id=? AND execution.session_id=? AND execution.logical_session_id=?
           AND execution.strategy='managedSandbox' AND execution.status IN ('preparing','binding')
         ORDER BY execution.updated_at DESC LIMIT 1`,
        [session.taskId, session.id, logical.logicalSessionId]
      ))
      : null;
    return {
      logicalSessionId: logical.logicalSessionId,
      providerBindingId: active.bindingId,
      providerId: active.providerId,
      providerSessionId: active.providerSessionId,
      routingVersion: active.routingVersion,
      state: active.state,
      isCurrent: logical.activeThreadId === active.providerThreadId,
      tombstoned: session?.deletedAt != null,
      sessionId: session?.id ?? null,
      sessionKind: session?.sessionKind ?? "legacy",
      workId: session?.workId ?? null,
      taskId: session?.taskId ?? null,
      currentTaskSessionId: task?.current_session_id ?? null,
      taskSessionAuthorization: task?.current_session_id === session?.id
        ? "current"
        : (startupAuthorization ? "startup" : null),
      startupOperationId: startupAuthorization?.startup_operation_id ?? null,
      agentId: session?.agentId ?? null,
      authorizationRevision: Math.max(
        Number(logical.routingVersion ?? 1),
        Number(task?.resource_version ?? 1),
        Number(startupAuthorization?.resource_version ?? 1)
      )
    };
  }

  function prospectiveToolHostBinding({ logicalSessionId, binding = {}, session = null }) {
    const task = session?.taskId ? store.getTask(session.taskId) : null;
    const providerBindingId = binding.bindingId ?? binding.providerBindingId;
    const providerSessionId = binding.providerSessionId ?? binding.providerThreadId;
    return {
      logicalSessionId,
      providerBindingId,
      providerId: binding.providerId,
      providerSessionId,
      routingVersion: Number(binding.routingVersion ?? 1),
      bindingGeneration: Number(binding.bindingGeneration ?? 1),
      state: "active",
      isCurrent: true,
      tombstoned: false,
      sessionId: session?.id ?? null,
      sessionKind: session?.sessionKind ?? "legacy",
      workId: session?.workId ?? null,
      taskId: session?.taskId ?? null,
      currentTaskSessionId: task?.current_session_id ?? null,
      agentId: session?.agentId ?? null,
      worktreeId: binding.worktreeId ?? null,
      repositoryId: binding.repositoryId ?? null,
      boundCwd: binding.boundCwd ?? null,
      authorizationRevision: Math.max(
        Number(binding.routingVersion ?? 1),
        Number(task?.resource_version ?? 1)
      )
    };
  }

  async function prepareDesiredWorkspaceToolMaterialization({
    logicalSessionId,
    sessionId,
    sourceBinding,
    binding
  }) {
    const session = sessionId ? store.getSession(sessionId) : null;
    const source = sourceBinding?.bindingId
      ? store.getSessionToolCatalogMaterialization(logicalSessionId, sourceBinding.bindingId)
      : null;
    return prepareDesiredReplacement({
      binding: prospectiveToolHostBinding({ logicalSessionId, binding, session }),
      desiredDomains: desiredToolDomainIds(source)
    });
  }

  return {
    sessionToolMetadata,
    resolveDynamicToolCallMetadata,
    resolveToolHostBinding,
    prospectiveToolHostBinding,
    prepareDesiredWorkspaceToolMaterialization
  };
}

export function desiredToolDomainIds(materialization = null) {
  return [...new Set([
    ...(materialization?.desiredDomains ?? []),
    ...(materialization?.appliedDomains ?? [])
  ].map((domain) => typeof domain === "string" ? domain : domain?.domainId)
    .filter(Boolean)
    .map((domainId) => domainId === "work-item-acceptance" ? "task-acceptance" : domainId))].sort();
}

export function appliedToolDomainIds(materialization = null) {
  if (!materialization
    || materialization.status !== "applied"
    || materialization.appliedVersion !== materialization.desiredVersion) return [];
  return [...new Set((materialization.appliedDomains ?? [])
    .map((domain) => typeof domain === "string" ? domain : domain?.domainId)
    .filter(Boolean))].sort();
}
