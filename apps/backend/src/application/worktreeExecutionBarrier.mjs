// Project-level scheduling policy shared by every Provider. Plan reservations
// serialize integration jobs; only execution barriers hold Session dispatch.
export function worktreeDispatchBlocker(store, reference) {
  const logical = reference.logicalSession ?? (reference.logicalSessionId ? store.getLogicalSession?.(reference.logicalSessionId) : null)
    ?? store.getLogicalSessionByLegacySessionId?.(reference.sessionId);
  if (!logical?.repositoryId || !logical.activeWorkspaceId) return null;
  const job = store.getLatestWorktreeIntegrationJob?.(logical.repositoryId);
  if (!job) return null;
  const workspaceId = logical.activeWorkspaceId;
  const safety = job.details?.dispatchSafety;
  const safetyCurrent = (safety?.verifiedRevision ?? 0) === (job.details?.dispatchRevision ?? 0);
  const blocked = reason => ({ reason, jobId: job.id, worktreeId: workspaceId,
    message: reason === "WORKTREE_CONFLICT_OR_RECOVERY"
      ? "Message received; the Worktree needs conflict resolution or recovery."
      : "Message received; waiting for Worktree integration to finish." });
  // Canceled jobs may leave a real merge/rebase behind. Canceling a job is
  // never permission to write into its unresolved Git operation.
  if (safety?.blockedWorktreeIds?.includes(workspaceId)) return blocked("WORKTREE_CONFLICT_OR_RECOVERY");
  if (job.status === "canceled" && job.phase === "canceled_conflict_preserved" && !safety
    && (job.details.plan.reservedWorktreeIds ?? job.details.plan.items?.map(item => item.worktreeId))?.includes(workspaceId)) {
    return blocked("WORKTREE_CONFLICT_OR_RECOVERY");
  }
  const active = ["queued", "running", "paused", "cancellation_requested", "replanning"].includes(job.status);
  if (!active) return null;
  const plan = job.details?.plan;
  if (plan?.orchestration || plan?.taskScope) {
    const state = job.details.graphExecution;
    const step = state?.steps[state.index];
    if (job.status === "paused" && ["awaiting_integration_acceptance", "recovery_required"].includes(job.phase)
      && step?.kind === "acceptance" && workspaceId === step.targetWorktreeId
      && (logical.taskId ?? store.getSession?.(logical.legacySessionId)?.taskId) === step.rootTaskId) return null;
    if (job.status === "paused" && job.phase !== "awaiting_integration_acceptance"
      && safetyCurrent && safety?.safeWorktrees?.some(tree => tree.worktreeId === workspaceId)) return null;
    return plan.reservedWorktreeIds?.includes(workspaceId) ? blocked("WORKTREE_INTEGRATION_IN_PROGRESS") : null;
  }
  const affected = job.details?.automaticFollow || plan?.operationType === "sync"
    ? plan?.items?.some(item => item.worktreeId === workspaceId && !item.isMain
      && !["completed", "already_integrated", "recovered"].includes(item.mergeStatus))
    : plan?.items?.some(item => item.worktreeId === workspaceId);
  if (!affected) return null;
  if (job.status === "paused" && safetyCurrent && safety?.safeWorktrees?.some(tree => tree.worktreeId === workspaceId)) return null;
  return blocked("WORKTREE_INTEGRATION_IN_PROGRESS");
}
