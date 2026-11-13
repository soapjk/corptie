// A delegation belongs to an exact Session pair. Source strings never grant it.
export function coordinationDelegation(store, logicalSessionId, { includeRetired = false } = {}) {
  const request = store.selectOne("SELECT main_session_id,parent_task_id,request_id,status FROM coordination_requests WHERE shadow_session_id=?", [logicalSessionId]);
  const summary = request ? null : store.selectOne("SELECT main_session_id,parent_task_id,state FROM coordination_shadow_sessions WHERE shadow_session_id=?", [logicalSessionId]);
  const delegation = request ?? summary;
  if (!delegation || summary && summary.state !== "ready"
    || request && !includeRetired && ["completed", "failed", "cancelled"].includes(request.status)) return null;
  const main = store.getLogicalSession(delegation.main_session_id);
  const target = store.getLogicalSession(logicalSessionId);
  const owner = main && store.getSession(main.legacySessionId);
  const session = target && store.getSession(target.legacySessionId);
  const task = store.getTask(delegation.parent_task_id);
  if (!task || task.archived || task.deletion_status || !owner || !session
    || owner.archived || owner.deletedAt || session.archived || session.deletedAt
    || main.archived || target.archived || main.activeBinding?.state !== "active" || target.activeBinding?.state !== "active"
    || task.current_session_id !== owner.id || owner.taskId !== task.id || session.taskId !== task.id
    || owner.workId !== task.work_id || session.workId !== task.work_id
    || session.agentId !== owner.agentId || task.main_agent_id && session.agentId !== task.main_agent_id) return null;
  return { kind: request ? "request-shadow" : "summary-shadow", mainSessionId: main.logicalSessionId,
    requestId: request?.request_id ?? null, executionPolicy: "host-coordination", taskId: task.id };
}

export function coordinationCreationPolicy(store, context) {
  if (!["coordination-request", "coordination-shadow"].includes(context.source)) return null;
  const main = store.getLogicalSession(context.shadowOwnerSessionId);
  const owner = main && store.getSession(main.legacySessionId);
  const task = owner?.taskId && store.getTask(owner.taskId);
  const record = context.source === "coordination-request"
    ? store.selectOne("SELECT * FROM coordination_requests WHERE request_id=?", [context.requestId])
    : store.selectOne("SELECT * FROM coordination_shadow_sessions WHERE main_session_id=?", [context.shadowOwnerSessionId]);
  if (!record || !task || record.main_session_id !== main?.logicalSessionId || record.parent_task_id !== task.id
    || record.shadow_session_id || owner.archived || owner.deletedAt || main.archived || main.activeBinding?.state !== "active"
    || task.archived || task.deletion_status || task.current_session_id !== owner.id
    || task.id !== context.taskId || task.work_id !== context.workId || owner.agentId !== context.actorId
    || ["completed", "failed", "cancelled"].includes(record.status)) {
    throw Object.assign(new Error("The coordination Session reservation is no longer valid."), { code: "COORDINATION_RESERVATION_INVALID" });
  }
  return "host-coordination";
}

// Existing retired/invalid delegations must never fall through to ordinary tools.
export function coordinationExecutionPolicy(store, logicalSessionId) {
  const delegation = coordinationDelegation(store, logicalSessionId);
  if (delegation) return delegation.executionPolicy;
  if (store.selectOne("SELECT 1 FROM coordination_requests WHERE shadow_session_id=?", [logicalSessionId])
    || store.selectOne("SELECT 1 FROM coordination_shadow_sessions WHERE shadow_session_id=?", [logicalSessionId])) {
    throw Object.assign(new Error("The coordination Session delegation is unavailable."), { code: "COORDINATION_DELEGATION_UNAVAILABLE" });
  }
  return null;
}
