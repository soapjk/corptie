import { resolveProjectWorktreeCommitMessage } from "../runtime/projectCommitMessage.mjs";

export function createProjectWorktreeGitOperations({
  store, gitWorkspaces, gitCommitProtection, projectToolsets,
  generateSessionCommitMessage, generateUnownedWorktreeCommitMessage,
  rebuildAndRestartProjectService, projectWorktreeStatus
}) {
  async function commitMessageForProjectWorktree(worktree, requestedMessage, requestingSessionId) {
    return resolveProjectWorktreeCommitMessage({
      worktree,
      requestedMessage,
      requestingSessionId,
      generateForSession: generateSessionCommitMessage,
      generateForUnownedWorktree: generateUnownedWorktreeCommitMessage
    });
  }

  async function resolveProjectCommitProtection(worktree, input = {}) {
    if (!worktree.dirty) return null;
    return gitCommitProtection.resolve(worktree.path, {
      decision: input.privateFilesDecision,
      neverRemind: input.neverRemindPrivateFiles === true
    });
  }

  async function mergeProjectWorktree(sessionId, sourceWorktreeId, input = {}) {
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) throw new Error("The Session no longer has an active workspace route.");
    const before = await gitWorkspaces.projectStatus(logical.logicalSessionId);
    const source = before.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    if (!source || source.isMain) throw new Error("The selected project worktree is not mergeable.");
    if (input.restartService === true) {
      const toolset = await projectToolsets.inspect(logical.activeBinding.boundCwd);
      if (!toolset.configured) {
        throw new Error("Configure the Corptie Scripts Tools Set before requesting merge and restart.");
      }
    }
    await resolveProjectCommitProtection(source, input);
    const commitMessage = await commitMessageForProjectWorktree(source, input.commitMessage, sessionId);
    const merge = await gitWorkspaces.mergeWorktreeIntoMain({
      logicalSessionId: logical.logicalSessionId,
      sourceWorktreeId,
      commitMessage,
      synchronizeSource: true
    });
    let restart = null;
    if (input.restartService === true) {
      restart = await rebuildAndRestartProjectService(logical.activeBinding.boundCwd);
    }
    const current = await projectWorktreeStatus(sessionId);
    return { merge, restart, ...current };
  }

  async function restartProjectWorktree(sessionId, sourceWorktreeId) {
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) throw new Error("The Session no longer has an active workspace route.");
    const before = await gitWorkspaces.projectStatus(logical.logicalSessionId);
    const source = before.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    if (!source || source.availability !== "available") {
      throw new Error("The selected project worktree is unavailable.");
    }
    const toolset = await projectToolsets.inspect(source.path);
    if (!toolset.configured) {
      throw new Error("Configure the Corptie Scripts Tools Set before restarting from this worktree.");
    }
    const restart = await rebuildAndRestartProjectService(source.path, source.path);
    const current = await projectWorktreeStatus(sessionId);
    return { restart, ...current };
  }

  async function commitProjectWorktree(sessionId, sourceWorktreeId, input = {}) {
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) throw new Error("The Session no longer has an active workspace route.");
    const before = await gitWorkspaces.projectStatus(logical.logicalSessionId);
    const source = before.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    if (!source || source.availability !== "available") {
      throw new Error("The selected project worktree is unavailable.");
    }
    if (!source.dirty) throw new Error("The selected worktree has no uncommitted changes.");
    await resolveProjectCommitProtection(source, input);
    const commitMessage = await commitMessageForProjectWorktree(source, input.commitMessage, sessionId);
    const commit = await gitWorkspaces.commitWorktreeChanges({
      logicalSessionId: logical.logicalSessionId,
      sourceWorktreeId,
      commitMessage
    });
    const current = await projectWorktreeStatus(sessionId);
    return { commit, ...current };
  }

  async function prepareProjectWorktreeCommit(sessionId, sourceWorktreeId) {
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) throw new Error("The Session no longer has an active workspace route.");
    const before = await gitWorkspaces.projectStatus(logical.logicalSessionId);
    const source = before.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    if (!source || source.availability !== "available") {
      throw new Error("The selected project worktree is unavailable.");
    }
    if (!source.dirty) throw new Error("The selected worktree has no uncommitted changes.");
    return gitCommitProtection.inspect(source.path);
  }

  async function generateProjectWorktreeCommitMessage(sessionId, sourceWorktreeId) {
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) throw new Error("The Session no longer has an active workspace route.");
    const before = await gitWorkspaces.projectStatus(logical.logicalSessionId);
    const source = before.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    if (!source || source.availability !== "available") {
      throw new Error("The selected project worktree is unavailable.");
    }
    if (!source.dirty) throw new Error("The selected worktree has no uncommitted changes.");
    return {
      commitMessage: await commitMessageForProjectWorktree(source, null, sessionId)
    };
  }

  return {
    commitMessageForProjectWorktree, resolveProjectCommitProtection,
    mergeProjectWorktree, restartProjectWorktree, commitProjectWorktree,
    prepareProjectWorktreeCommit, generateProjectWorktreeCommitMessage
  };
}
