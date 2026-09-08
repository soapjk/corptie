// Route recovery for deletion is based on the recorded allocation, never a
// Provider name, title, guessed directory, or an unverified Session cwd.
export async function inspectFailedStartupDeletion({ task, session, store, gitWorkspaces, isBusy }) {
  const blocked = (blocker = "NO_WORKSPACE_ROUTE", detail = null) => ({
    status: "unavailable", sessionId: session.id, worktree: null, canReclaim: false, blocker, detail
  });
  const operations = store.selectAll(
    "SELECT * FROM work_session_startup_operations WHERE task_id=? AND worktree_id IS NOT NULL",
    [task.id]
  );
  if (!operations.length || new Set(operations.map(row => row.worktree_id)).size !== 1) return blocked();
  if (operations.some(row => !["failed_manual_cleanup", "failed_compensated"].includes(row.state))) return blocked();
  const repositoryId = store.getTaskWorkspaceContext(task)?.repository?.id;
  const target = store.getGitWorktree(operations[0].worktree_id);
  if (!target || target.repositoryId !== repositoryId) return blocked();
  if (target.isMain) return blocked("MAIN_WORKTREE");
  let allocation;
  const owner = operations.find(row => {
    try {
      const value = JSON.parse(row.allocation_json ?? "null");
      if (value?.reused !== false || value.createdByStartupOperationId !== row.startup_operation_id
        || value.worktreeId !== target.worktreeId || value.repositoryId !== repositoryId
        || row.repository_id !== repositoryId || !value.canonicalWorktreePath
        || !value.headIdentity?.branch) return false;
      allocation = value;
      return true;
    } catch { return false; }
  });
  if (!owner || (target.createdByStartupOperationId && target.createdByStartupOperationId !== owner.startup_operation_id)) return blocked();
  const otherOwner = store.selectOne(
    "SELECT task_id FROM work_session_startup_operations WHERE worktree_id=? AND task_id<>? LIMIT 1",
    [target.worktreeId, task.id]
  );
  if (otherOwner) return blocked("SHARED_WITH_ACTIVE_TASK");
  if (store.listSessionsByTask(task.id).some(isBusy)) return blocked("SESSION_BUSY");
  try {
    const inventory = await gitWorkspaces.taskDeletionStatusForWorktree(repositoryId, target.worktreeId);
    const worktree = inventory.worktrees.find(row => row.worktreeId === target.worktreeId);
    if (!worktree || worktree.availability !== "available") return blocked("WORKTREE_UNAVAILABLE");
    if (worktree.isMain) return blocked("MAIN_WORKTREE");
    if (worktree.canonicalPath !== allocation.canonicalWorktreePath
      || worktree.branchName !== allocation.headIdentity.branch) return blocked();
    for (const binding of worktree.sessions ?? []) {
      const bound = binding.sessionId ? store.getSession(binding.sessionId) : null;
      if (!bound || bound.taskId !== task.id) return blocked("SHARED_WITH_ACTIVE_TASK");
      if (isBusy(bound)) return blocked("SESSION_BUSY");
    }
    return {
      status: "available", sessionId: session.id, repositoryId, worktree,
      // This proof authorizes the deletion inspection, not the separate
      // completed-Task reclaim operation, which still requires a live route.
      canReclaim: false,
      blocker: worktree.dirty ? "UNCOMMITTED_CHANGES"
        : worktree.mergedIntoMain === true ? null : "NOT_MERGED_INTO_MAIN",
      ownershipSource: "failed-startup-allocation", startupOperationId: owner.startup_operation_id
    };
  } catch (error) {
    return blocked("WORKTREE_UNAVAILABLE", error.message);
  }
}
