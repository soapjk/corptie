export function resolveConflictResolutionAgentContext(item, store) {
  const taskIds = [];
  for (const association of item?.associations ?? []) {
    if (association?.taskId) taskIds.push(association.taskId);
  }
  if (item?.worktreeId && typeof store?.listLogicalSessionsByWorkspaceId === "function") {
    for (const logical of store.listLogicalSessionsByWorkspaceId(item.worktreeId)) {
      const session = logical?.legacySessionId ? store.getSession(logical.legacySessionId) : null;
      if (session?.taskId) taskIds.push(session.taskId);
    }
  }
  for (const taskId of new Set(taskIds)) {
    const sourceTask = store.getTask(taskId);
    const work = sourceTask?.work_id ? store.getWork(sourceTask.work_id) : null;
    const agent = sourceTask?.main_agent_id ? store.getAgent(sourceTask.main_agent_id) : null;
    if (sourceTask && work && agent?.role === "independentContributor") {
      return { sourceTask, work, agent };
    }
  }
  return null;
}
