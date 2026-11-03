// An integration job owns writes to specific worktrees, not its entire repo.
export function integrationBlocksWorkspaceCapture(job, worktreeId, worktrees = []) {
  const details=job.details ?? JSON.parse(job.details_json || "{}"), plan=details.plan;
  if(!plan) return true;
  if(job.phase==="awaiting_integration_acceptance"
    && !plan.items?.some(item=>item.mergeStatus==="conflict")) return false;
  const writes=plan.writeWorktreeIds ?? (plan.operationType==="sync" ? plan.sourceWorktreeIds
    : [plan.targetWorktreeId ?? plan.mainWorktreeId,
      ...(plan.items ?? []).filter(item=>["pending","running"].includes(item.commitStatus)).map(item=>item.worktreeId)]);
  if(!Array.isArray(writes) || writes.some(id=>!id)) return true;
  const parent=worktrees.find(tree=>tree.worktreeId===worktreeId);
  return writes.some(id=>id===worktreeId || parent?.branchName && worktrees.some(tree=>tree.worktreeId===id && tree.branchName===parent.branchName));
}
