// Read-only projection of the execution evidence already held by an integration
// Job. A graph changes its current plan at each step; rollback must include the
// completed steps as well as the active one, in reverse dependency order.
export function integrationRollbackTargets(job) {
  const details = job.details ?? job;
  const plan = details.plan;
  if (!plan || plan.operationType === "sync") return [];
  const graph = details.graphExecution;
  const groups = new Map();
  const add = (items, targetId, path, fallbackHead) => {
    const target = items.find(item => item.worktreeId === targetId);
    if (!target) return;
    const writes = items.filter(item => item.worktreeId !== targetId
      && ["running", "completed", "recovered", "conflict", "failed"].includes(item.mergeStatus)
      && !item.snapshotReceipt?.noChanges);
    if (!writes.length) return;
    let group = groups.get(targetId);
    if (!group) {
      group = { worktreeId: targetId, path: path ?? target.path, branchName: target.branchName,
        baselineHead: writes[0].snapshotReceipt?.parentBefore ?? target.sourceHeadBefore ?? fallbackHead,
        writes: [] };
      groups.set(targetId, group);
    }
    for (const item of writes) {
      const write = { sourceWorktreeId: item.worktreeId,
        sourceHead: item.resolutionHead ?? item.commitHead ?? item.sourceHeadBefore,
        resultHead: item.mergeMainHead ?? null,
        beforeHead: item.snapshotReceipt?.parentBefore ?? null,
        status: item.mergeStatus };
      if (!group.writes.some(prior => prior.sourceWorktreeId === write.sourceWorktreeId
        && prior.sourceHead === write.sourceHead && prior.resultHead === write.resultHead)) group.writes.push(write);
    }
    // The last write determines when this target must be restored. A parent
    // can be written both before and after another graph target.
    groups.delete(targetId);
    groups.set(targetId, group);
  };
  for (const step of graph?.steps ?? []) {
    if (step.items) add(step.items, step.targetWorktreeId, null, null);
  }
  if (!graph || graph.phase !== "committing") {
    if (plan.operationType === "converge") {
      const workspace = details.convergenceWorkspace;
      if (workspace) add((plan.items ?? []).map(item => item.worktreeId === plan.mainWorktreeId
        ? { ...item, ...workspace, sourceHeadBefore: plan.mainHeadBefore } : item),
        workspace.worktreeId, workspace.path, plan.mainHeadBefore);
      for (const item of plan.items ?? []) {
        if (!["running", "completed", "failed"].includes(item.convergenceStatus)) continue;
        groups.set(item.worktreeId, { worktreeId: item.worktreeId, path: item.path, branchName: item.branchName,
          baselineHead: item.sourceHeadBefore, writes: [{ sourceWorktreeId: workspace?.worktreeId ?? null,
            sourceHead: item.mergeMainHead ?? null, resultHead: item.mergeMainHead ?? null,
            beforeHead: item.sourceHeadBefore, status: item.convergenceStatus }] });
      }
    } else {
      add(plan.items ?? [], plan.mainWorktreeId, plan.executionPath ?? plan.mainPath, plan.mainHeadBefore);
    }
  }
  return [...groups.values()].reverse();
}

// HEAD inequality is an observation, not a terminal recovery decision. Git
// inspection supplies exact commits and parents; this function never writes.
export function classifyIntegrationRollback(target, observation) {
  const known = new Set(target.writes.map(write => write.resultHead).filter(Boolean));
  let expected = target.baselineHead;
  const ownedCommits = [], additionalCommits = [];
  for (const commit of observation.commits ?? []) {
    const recorded = known.has(commit.head);
    const resolvedConflict = target.writes.some(write => !write.resultHead
      && ["conflict", "running", "failed"].includes(write.status)
      && commit.parents[0] === expected && commit.parents.slice(1).includes(write.sourceHead));
    (recorded || resolvedConflict ? ownedCommits : additionalCommits).push(commit.head);
    expected = commit.head;
  }
  const operationOwned = observation.operation === "merge"
    && target.writes.some(write => write.sourceHead === observation.mergeHead
      && ["conflict", "running", "failed"].includes(write.status));
  const unrelatedOperation = Boolean(observation.operation) && !operationOwned;
  const mode = unrelatedOperation ? "resolve_git_operation"
    : observation.head === target.baselineHead && !observation.operation && !observation.dirty ? "already_restored"
    : !observation.baselineIsAncestor ? "restore_diverged_baseline"
    : additionalCommits.length || observation.published ? "review_additional_history" : "restore_baseline";
  return { ...target, currentHead: observation.head, operation: observation.operation ?? null,
    dirty: observation.dirty === true, changedFiles: observation.changedFiles ?? [],
    ownedCommits, additionalCommits, operationOwned, mode,
    requiresPreservation: observation.dirty === true || operationOwned };
}
