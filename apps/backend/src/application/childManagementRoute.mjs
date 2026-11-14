// Read-only relationship policy shared by delivery and timeline projection.
// Communication identities remain unchanged when execution is delegated.
export function childManagementRelation(store, senderId, recipientId) {
  const resolve = id => {
    const logical = store.getLogicalSession(id) ?? store.getLogicalSessionByLegacySessionId(id);
    const session = logical && store.getSession(logical.legacySessionId);
    return { logical, session, task: session?.taskId && store.getTask(session.taskId) };
  };
  const sender = resolve(senderId), recipient = resolve(recipientId);
  if (!sender.task || !recipient.task || sender.task.work_id !== recipient.task.work_id) return null;
  const parent = sender.task.parent_task_id === recipient.task.id ? recipient
    : recipient.task.parent_task_id === sender.task.id ? sender : null;
  if (!parent) return null;
  const executor = parent.logical.logicalSessionId;
  // A delegated summary must be able to instruct children without routing back
  // to itself. Historical main bindings, however, cannot bypass delegation.
  if (store.selectOne("SELECT 1 FROM coordination_shadow_sessions WHERE shadow_session_id=?", [executor])) return null;
  const current = parent.task.current_session_id && store.getLogicalSessionByLegacySessionId(parent.task.current_session_id);
  return { parentTaskId: parent.task.id, mainSessionId: current?.logicalSessionId ?? null };
}
