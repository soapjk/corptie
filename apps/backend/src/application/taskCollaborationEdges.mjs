// Product read projection only. Sessions remain the Channel participants.
export function taskCollaborationEdges(store) {
  const tasks = new Map();
  const taskFor = (id) => {
    if (!tasks.has(id)) {
      const logical = store.getLogicalSession(id);
      tasks.set(id, logical?.legacySessionId ? store.getSession(logical.legacySessionId)?.taskId ?? null : null);
    }
    return tasks.get(id);
  };
  return store.selectAll("SELECT channel_id, session_a_id, session_b_id FROM session_collaboration_channels WHERE status='active'")
    .flatMap(row => {
      const sourceTaskId = taskFor(row.session_a_id), targetTaskId = taskFor(row.session_b_id);
      return sourceTaskId && targetTaskId && sourceTaskId !== targetTaskId
        ? [{ id: row.channel_id, sourceTaskId, targetTaskId, sourceSessionId: row.session_a_id, targetSessionId: row.session_b_id }] : [];
    });
}
