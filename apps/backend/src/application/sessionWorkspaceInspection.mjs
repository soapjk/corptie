import { recoverableAgentWorkDir } from "../runtime/agentWorkDir.mjs";

// Inspects recovery choices without changing Session bindings. Inventory refresh
// may update known worktrees, but failure retains the last known candidates.
export function createSessionWorkspaceInspection({
  store, gitWorkspaces, assertWorkspaceRouteUsable, createGitWorkspaceSnapshot
}) {
  async function sessionDeletionPlan(sessionId) {
    if (!String(sessionId).startsWith("codex:")) return { requiresWorktreeMerge: false };
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical?.activeBinding) return { requiresWorktreeMerge: false };
    try {
      await assertWorkspaceRouteUsable({
        store,
        logicalSession: logical,
        providerThreadId: logical.activeThreadId
      });
    } catch (error) {
      if (["WORKSPACE_UNAVAILABLE", "WORKSPACE_IDENTITY_CHANGED"].includes(error?.code)) {
        const worktree = logical.activeWorkspaceId
          ? store.getGitWorktree(logical.activeWorkspaceId)
          : null;
        return {
          requiresWorktreeMerge: false,
          workspaceUnavailable: true,
          sourcePath: logical.activeBinding.boundCwd,
          sourceBranch: worktree?.branchName ?? null,
          unavailableReason: error.message
        };
      }
      throw error;
    }
    return gitWorkspaces.sessionDeletionPlan(logical.logicalSessionId);
  }

  async function sessionWorkspaceRecoveryStatus(sessionId) {
    const session = store.getSession(sessionId);
    const logical = store.getLogicalSessionByLegacySessionId(sessionId);
    if (!session || !logical?.activeBinding) {
      const error = new Error("Session workspace route not found.");
      error.statusCode = 404;
      throw error;
    }
    let workspaceError = null;
    try {
      await assertWorkspaceRouteUsable({
        store,
        logicalSession: logical,
        providerThreadId: logical.activeThreadId
      });
      return { orphaned: false, worktrees: [] };
    } catch (error) {
      if (!["WORKSPACE_UNAVAILABLE", "WORKSPACE_IDENTITY_CHANGED"].includes(error?.code)) throw error;
      workspaceError = error;
    }
    if (!logical.repositoryId) {
      const agent = store.getAgent(session.agentId);
      const recoveryTarget = workspaceError?.code === "WORKSPACE_UNAVAILABLE"
        ? recoverableAgentWorkDir(agent, logical.activeBinding.boundCwd)
        : null;
      return {
        orphaned: true,
        recoveryKind: recoveryTarget ? "agentWorkspace" : "unavailable",
        originalPath: logical.activeBinding.boundCwd,
        originalBranchName: null,
        canRebuild: Boolean(recoveryTarget),
        worktrees: []
      };
    }
    const original = logical.activeWorkspaceId ? store.getGitWorktree(logical.activeWorkspaceId) : null;
    const knownMain = store.listGitWorktrees(logical.repositoryId).find((worktree) => {
      return worktree.isMain && worktree.availability === "available";
    });
    let available = store.listGitWorktrees(logical.repositoryId).filter((worktree) => {
      return worktree.availability === "available" && worktree.worktreeId !== logical.activeWorkspaceId;
    });
    if (knownMain?.path) {
      try {
        const snapshot = await createGitWorkspaceSnapshot(knownMain.path);
        store.upsertGitWorkspaceSnapshot(snapshot);
        available = snapshot.worktrees.filter((worktree) => {
          return worktree.availability === "available" && worktree.worktreeId !== logical.activeWorkspaceId;
        });
      } catch {
        // Preserve the last known inventory; route validation still prevents unsafe use.
      }
    }
    return {
      orphaned: true,
      recoveryKind: "gitWorktree",
      originalPath: logical.activeBinding.boundCwd,
      originalBranchName: original?.branchName ?? null,
      canRebuild: Boolean(original?.branchName && !original?.isMain),
      worktrees: available.map((worktree) => ({
        worktreeId: worktree.worktreeId,
        path: worktree.canonicalPath || worktree.path,
        branchName: worktree.branchName,
        isMain: worktree.isMain,
        availability: worktree.availability
      }))
    };
  }

  return { sessionDeletionPlan, sessionWorkspaceRecoveryStatus };
}
