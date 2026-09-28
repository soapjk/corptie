import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";

// Coordinates explicitly requested project worktree operations.
// Dependencies are project/session services, never concrete Provider adapters.
export function createProjectWorktreeOperations({
  store, gitWorkspaces, projectToolsets, collaborationCore,
  resolveProjectCommitProtection, commitMessageForProjectWorktree,
  rebuildAndRestartProjectService, emitEvent
}) {
  async function completeProjectWorktree(sessionId, sourceWorktreeId, input = {}) {
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) throw new Error("The Session no longer has an active workspace route.");
    const before = await gitWorkspaces.projectStatus(logical.logicalSessionId);
    const source = before.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    if (!source || source.isMain) throw new Error("The selected project worktree cannot be completed.");
    if (input.deleteSessions !== true && source.sessions.length > 0) {
      throw new Error("Completing this worktree requires confirmation to delete its associated Sessions.");
    }
    for (const binding of source.sessions) {
      const session = binding.sessionId
        ? store.getSession(binding.sessionId)
        : null;
      if (sessionHasActiveRun(session)) {
        const error = new Error(`Session ${session.title || binding.sessionId} is busy. Wait for it before completing the worktree.`);
        error.code = "SESSION_BUSY";
        throw error;
      }
    }
    const toolset = await projectToolsets.inspect(logical.activeBinding.boundCwd);
    if (input.restartService !== false && !toolset.configured) {
      throw new Error("Configure the Corptie Scripts Tools Set before completing and restarting this worktree.");
    }
    await resolveProjectCommitProtection(source, input);
    const commitMessage = await commitMessageForProjectWorktree(source, input.commitMessage, sessionId);
    const merge = await gitWorkspaces.mergeWorktreeIntoMain({
      logicalSessionId: logical.logicalSessionId,
      sourceWorktreeId,
      commitMessage,
      synchronizeSource: false
    });
    const logicalSessionIds = source.sessions.map((item) => item.logicalSessionId);
    const cleanup = await gitWorkspaces.removeMergedWorktree({
      logicalSessionId: logical.logicalSessionId,
      sourceWorktreeId,
      ignoreLogicalSessionIds: logicalSessionIds,
      deleteBranch: input.deleteBranch !== false
    });
    const deletedSessionIds = [];
    for (const binding of source.sessions) {
      if (!binding.sessionId) continue;
      collaborationCore.detachSession(binding.sessionId);
      store.deleteLogicalSessionByLegacySessionId(binding.sessionId);
      store.deleteSession(binding.sessionId);
      deletedSessionIds.push(binding.sessionId);
      emitEvent("SessionDeleted", {
        sessionId: binding.sessionId,
        provider: "codex-app-server",
        reason: "worktreeCompleted"
      }, { detachedSession: true });
    }
    let restart = null;
    if (input.restartService !== false) {
      restart = await rebuildAndRestartProjectService(before.mainPath);
    }
    emitEvent("ProjectWorktreeCompleted", {
      repositoryId: before.repositoryId,
      sourceWorktreeId,
      merge,
      cleanup,
      deletedSessionIds,
      restart
    });
    return { merge, cleanup, deletedSessionIds, restart };
  }

  async function operateProjectWorktree(sessionId, sourceWorktreeId, input = {}) {
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) throw new Error("The Session no longer has an active workspace route.");
    const operations = {
      mergeIntoMain: input.mergeIntoMain === true,
      synchronizeWithMain: input.synchronizeWithMain === true,
      deleteWorktree: input.deleteWorktree === true,
      deleteSessions: input.deleteSessions === true,
      restartService: input.restartService === true
    };
    if (!Object.values(operations).some(Boolean)) {
      throw new Error("Select at least one worktree operation.");
    }
    if (operations.deleteWorktree && (operations.mergeIntoMain || operations.synchronizeWithMain)) {
      throw new Error("Deleting a worktree cannot be combined with merging or synchronizing it.");
    }

    const before = await gitWorkspaces.projectStatus(logical.logicalSessionId);
    const source = before.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    if (!source || source.isMain || source.availability !== "available") {
      throw new Error("The selected project worktree is unavailable.");
    }
    if (operations.deleteWorktree && source.sessions.length > 0 && !operations.deleteSessions) {
      throw new Error("Delete the associated Sessions before deleting this worktree.");
    }
    if (operations.deleteSessions) {
      for (const binding of source.sessions) {
        const session = binding.sessionId
          ? store.getSession(binding.sessionId)
          : null;
        if (sessionHasActiveRun(session)) {
          const error = new Error(`Session ${session?.title || binding.sessionId} is busy. Wait for it before deleting associated Sessions.`);
          error.code = "SESSION_BUSY";
          throw error;
        }
      }
    }
    if (operations.restartService) {
      const toolset = await projectToolsets.inspect(before.mainPath);
      if (!toolset.configured) {
        throw new Error("Configure the Corptie Scripts Tools Set before restarting the service.");
      }
    }

    let merge = null;
    if (operations.mergeIntoMain) {
      await resolveProjectCommitProtection(source, input);
      const commitMessage = await commitMessageForProjectWorktree(source, input.commitMessage, sessionId);
      merge = await gitWorkspaces.mergeWorktreeIntoMain({
        logicalSessionId: logical.logicalSessionId,
        sourceWorktreeId,
        commitMessage,
        synchronizeSource: false
      });
    }

    let synchronization = null;
    if (operations.synchronizeWithMain) {
      synchronization = await gitWorkspaces.synchronizeWorktreeWithMain({
        logicalSessionId: logical.logicalSessionId,
        sourceWorktreeId
      });
    }

    const logicalSessionIds = source.sessions.map((item) => item.logicalSessionId);
    let cleanup = null;
    if (operations.deleteWorktree) {
      cleanup = await gitWorkspaces.removeMergedWorktree({
        logicalSessionId: logical.logicalSessionId,
        sourceWorktreeId,
        ignoreLogicalSessionIds: operations.deleteSessions ? logicalSessionIds : [],
        deleteBranch: true,
        forceDeleteUnmerged: input.forceDeleteUnmerged === true,
        acknowledgeIrrecoverable: input.acknowledgeIrrecoverable === true,
        confirmedBranchName: input.confirmedBranchName
      });
    }

    const deletedSessionIds = [];
    if (operations.deleteSessions) {
      for (const binding of source.sessions) {
        if (!binding.sessionId) continue;
        collaborationCore.detachSession(binding.sessionId);
        store.deleteLogicalSessionByLegacySessionId(binding.sessionId);
        store.deleteSession(binding.sessionId);
        deletedSessionIds.push(binding.sessionId);
        emitEvent("SessionDeleted", {
          sessionId: binding.sessionId,
          provider: "codex-app-server",
          reason: "worktreeOperation"
        }, { detachedSession: true });
      }
    }

    let restart = null;
    if (operations.restartService) {
      restart = await rebuildAndRestartProjectService(before.mainPath);
    }
    emitEvent("ProjectWorktreeOperated", {
      repositoryId: before.repositoryId,
      sourceWorktreeId,
      operations,
      merge,
      synchronization,
      cleanup,
      deletedSessionIds,
      restart
    });
    return { operations, merge, synchronization, cleanup, deletedSessionIds, restart };
  }

  return { completeProjectWorktree, operateProjectWorktree };
}
