// The optional merge and cleanup must finish before the Session is deleted.
export async function deleteSessionWithOptionalMerge(rawId, { mergeWorktree = false } = {}, {
  sessionApplicationService, sessionDeletionPlan, mergeSessionWorktreeBeforeDeletion,
  store, gitWorkspaces, supportsMergeBeforeDeletion
}) {
  const reference = await sessionApplicationService.referenceFor(rawId);
  let merge = null;
  if (mergeWorktree) {
    if (!supportsMergeBeforeDeletion(reference)) {
      const error = new Error("Worktree merge before deletion is unavailable for this Agent Provider.");
      error.code = "CAPABILITY_UNSUPPORTED";
      throw error;
    }
    const plan = await sessionDeletionPlan(reference.sessionId);
    if (!plan.requiresWorktreeMerge) {
      throw new Error("The Session is no longer bound to a mergeable worktree.");
    }
    merge = await mergeSessionWorktreeBeforeDeletion(reference.sessionId, plan);
    const logical = store.getLogicalSessionByLegacySessionId(reference.sessionId);
    if (logical && merge?.sourceWorktreeId) {
      const otherBindings = store.listLogicalSessionsByWorkspaceId(merge.sourceWorktreeId)
        .filter((item) => item.logicalSessionId !== logical.logicalSessionId);
      merge.cleanup = otherBindings.length > 0
        ? { removed: false, reason: "sharedWorktree", remainingSessionCount: otherBindings.length }
        : await gitWorkspaces.removeMergedWorktree({
            logicalSessionId: logical.logicalSessionId,
            sourceWorktreeId: merge.sourceWorktreeId,
            ignoreLogicalSessionIds: [logical.logicalSessionId],
            deleteBranch: true
          });
    }
  }
  const result = await sessionApplicationService.deleteSession(rawId, { source: "http" });
  return { ...result, merge };
}
