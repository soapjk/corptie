// An integration job owns writes to specific worktrees, not its entire repo.
export function integrationBlocksWorkspaceCapture(job, worktreeId, worktrees = []) {
  const details=job.details ?? JSON.parse(job.details_json || "{}"), plan=details.plan;
  if(!plan) return true;
  // A failed resume cannot run this stale plan again. Release only a worktree
  // that the integration service actually verified/released at this revision.
  // Capture still validates live Git operation markers under its write lock.
  const safety = details.dispatchSafety;
  if (job.status === "paused" && details.resumeRequiresReplan === true
    && safety && Number.isInteger(details.dispatchRevision)
    && safety.verifiedRevision === details.dispatchRevision
    && safety.safeWorktrees?.some(tree => tree.worktreeId === worktreeId)
    && !safety.blockedWorktreeIds?.includes(worktreeId)) return false;
  if(job.phase==="awaiting_integration_acceptance"
    && !plan.items?.some(item=>item.mergeStatus==="conflict")) return false;
  const writes=plan.writeWorktreeIds ?? (plan.operationType==="sync" ? plan.sourceWorktreeIds
    : [plan.targetWorktreeId ?? plan.mainWorktreeId,
      ...(plan.items ?? []).filter(item=>["pending","running"].includes(item.commitStatus)).map(item=>item.worktreeId)]);
  if(!Array.isArray(writes) || writes.some(id=>!id)) return true;
  const parent=worktrees.find(tree=>tree.worktreeId===worktreeId);
  return writes.some(id=>id===worktreeId || parent?.branchName && worktrees.some(tree=>tree.worktreeId===id && tree.branchName===parent.branchName));
}
