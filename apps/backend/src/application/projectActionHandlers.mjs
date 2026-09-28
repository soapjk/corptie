// Project-level operations use repository/worktree identity, never a concrete
// Provider adapter. Confirmation fields are passed through to the Git authority.
export function createProjectActionHandlers({
  store, gitWorkspaces, projectToolsets, gitCommitProtection, gitHubPushes,
  rebuildAndRestartProjectService, generateUnownedWorktreeCommitMessage,
  resolveProjectCommitProtection
}) {
  function resolveProjectContext(projectId) {
    const repository = store.getGitRepository(projectId);
    if (!repository) return null;
    const worktrees = store.listGitWorktrees(projectId);
    const main = worktrees.find((worktree) => worktree.isMain && worktree.availability === "available");
    if (!main?.path) return null;
    return {
      id: repository.id,
      mainPath: main.canonicalPath || main.path,
      mainWorkspaceId: main.worktreeId
    };
  }

  async function performProjectDevelopmentServiceAction(project, action, input = {}) {
    if (!["initialize", "update", "profile", "start", "restart", "stop"].includes(action)) {
      const error = new Error(`Unsupported development service action: ${action}`);
      error.code = "INVALID_PROJECT_ACTION";
      throw error;
    }
    if (action === "initialize" || action === "update") {
      const error = new Error("Project Toolset initialization requires an authenticated Work Session.");
      error.code = "TOOLSET_PERMISSION_DENIED";
      error.statusCode = 403;
      throw error;
    }
    if (action === "profile") {
      const profileId = String(input.profileId ?? "").trim();
      if (!profileId) throw new Error("A Corptie service profile is required.");
      return projectToolsets.selectProfile(project.mainPath, profileId);
    }
    if (action === "start" || action === "restart") {
      return rebuildAndRestartProjectService(project.mainPath);
    }
    return projectToolsets.run(project.mainPath, "stop");
  }

  async function performProjectWorkspaceAction(project, workspaceId, action, input = {}) {
    if (!["commit-prepare", "commit-message", "commit", "merge", "synchronize", "delete", "restart", "push"].includes(action)) {
      const error = new Error(`Unsupported workspace action: ${action}`);
      error.code = "INVALID_PROJECT_ACTION";
      throw error;
    }
    const status = await gitWorkspaces.projectStatusForPath(project.mainPath, project.id, {
      inspectionLevel: "management",
      forceFresh: true,
      reason: `workspace_action_${action}_preflight`
    });
    const workspace = status.worktrees.find((candidate) => candidate.worktreeId === workspaceId);
    if (!workspace || workspace.availability !== "available") {
      const error = new Error("The selected workspace is unavailable or does not belong to this Project.");
      error.code = "WORKSPACE_NOT_FOUND";
      throw error;
    }
    if (action === "commit-prepare") {
      if (workspace.dirty !== true) throw new Error("The selected workspace has no uncommitted changes.");
      return gitCommitProtection.inspect(workspace.path);
    }
    if (action === "commit-message") {
      if (workspace.dirty !== true) throw new Error("The selected workspace has no uncommitted changes.");
      const commitMessage = await generateUnownedWorktreeCommitMessage(null, workspace.path, workspace);
      return { commitMessage };
    }
    if (action === "restart") {
      const toolset = await projectToolsets.inspect(workspace.path);
      if (!toolset.configured) {
        throw new Error("Configure the Corptie Scripts Tools Set before restarting from this workspace.");
      }
      return rebuildAndRestartProjectService(workspace.path, workspace.path);
    }
    if (action === "synchronize") {
      return gitWorkspaces.synchronizeWorktreeWithMainForProject({
        repositoryId: project.id,
        workingDirectory: project.mainPath,
        sourceWorktreeId: workspaceId
      });
    }
    if (action === "delete") {
      return gitWorkspaces.removeWorktreeForProject({
        repositoryId: project.id,
        workingDirectory: project.mainPath,
        sourceWorktreeId: workspaceId,
        deleteBranch: input.deleteBranch !== false,
        forceDeleteUnmerged: input.forceDeleteUnmerged === true,
        acknowledgeIrrecoverable: input.acknowledgeIrrecoverable === true,
        confirmedBranchName: input.confirmedBranchName
      });
    }
    if (action === "push") {
      return gitHubPushes.pushBranch({ workingDirectory: workspace.path });
    }
    await resolveProjectCommitProtection(workspace, input);
    if (action === "commit") {
      return gitWorkspaces.commitWorktreeChangesForProject({
        repositoryId: project.id,
        workingDirectory: project.mainPath,
        sourceWorktreeId: workspaceId,
        commitMessage: input.commitMessage
      });
    }
    return gitWorkspaces.mergeWorktreeIntoMainForProject({
      repositoryId: project.id,
      workingDirectory: project.mainPath,
      sourceWorktreeId: workspaceId,
      commitMessage: input.commitMessage,
      synchronizeSource: input.synchronizeSource === true
    });
  }

  return { resolveProjectContext, performProjectDevelopmentServiceAction, performProjectWorkspaceAction };
}
