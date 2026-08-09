export class SessionWorktreeService {
  constructor(options = {}) {
    this.gitWorkspaces = options.gitWorkspaces;
    this.workspaceCoordinator = options.workspaceCoordinator;
    if (!this.gitWorkspaces || !this.workspaceCoordinator) {
      throw new TypeError("SessionWorktreeService requires Git workspaces and a Workspace Coordinator.");
    }
  }

  async createWorktree(sessionId, input = {}) {
    const created = await this.gitWorkspaces.createWorktree({
      logicalSessionId: requiredText(input.logicalSessionId, "logicalSessionId"),
      targetPath: input.targetPath,
      branch: input.branch,
      baseRef: input.baseRef,
      createBranch: input.createBranch,
      detach: input.detach,
      inventoryVersion: input.inventoryVersion,
      switchAfterCreate: false
    });
    if (input.switchAfterCreate === false) {
      return { ...created, transition: null };
    }
    const transition = await this.workspaceCoordinator.switchWorkspace(sessionId, {
      targetWorkspaceId: created.worktree.worktreeId,
      continuationPrompt: input.continuationPrompt
    });
    return { ...created, transition };
  }

  switchWorkspace(sessionId, targetWorkspaceId, continuationPrompt = undefined) {
    return this.workspaceCoordinator.switchWorkspace(sessionId, {
      targetWorkspaceId,
      continuationPrompt
    });
  }
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}
