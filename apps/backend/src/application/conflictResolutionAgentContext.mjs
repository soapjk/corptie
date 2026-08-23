export function resolveConflictResolutionAgentContext(item, store) {
  const workItemIds = [];
  for (const association of item?.associations ?? []) {
    if (association?.workItemId) workItemIds.push(association.workItemId);
  }
  if (item?.worktreeId && typeof store?.listLogicalSessionsByWorkspaceId === "function") {
    for (const logical of store.listLogicalSessionsByWorkspaceId(item.worktreeId)) {
      const session = logical?.legacySessionId ? store.getSession(logical.legacySessionId) : null;
      if (session?.workItemId) workItemIds.push(session.workItemId);
    }
  }
  for (const workItemId of new Set(workItemIds)) {
    const sourceWorkItem = store.getWorkItem(workItemId);
    const objective = sourceWorkItem?.objective_id ? store.getObjective(sourceWorkItem.objective_id) : null;
    const agent = sourceWorkItem?.main_agent_id ? store.getAgent(sourceWorkItem.main_agent_id) : null;
    if (sourceWorkItem && objective && agent?.role === "independentContributor") {
      return { sourceWorkItem, objective, agent };
    }
  }
  return null;
}
