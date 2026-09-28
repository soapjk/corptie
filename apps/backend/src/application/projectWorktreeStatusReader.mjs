import { resolve } from "node:path";

export function createProjectWorktreeStatusReader({
  store, requireSessionReference, ensureLogicalRouteForProviderSession,
  projectToolsetAuthenticatedSession, projectToolsetStatusForPath,
  projectToolsets, gitWorkspaces, gitHubPushes
}) {
  function projectWorkingDirectoryForSession(sessionId) {
    const reference = requireSessionReference(sessionId);
    const session = reference.metadata.session;
    const logical = reference.logicalSessionId
      ? store.getLogicalSession(reference.logicalSessionId)
      : store.getLogicalSessionByLegacySessionId(reference.sessionId);
    const cwd = logical?.activeBinding?.boundCwd ?? session?.external?.cwd ?? session?.cwd;
    if (!cwd) {
      const error = new Error("The Session is not attached to a local project directory.");
      error.statusCode = 404;
      throw error;
    }
    return cwd;
  }

  async function projectToolsetStatus(sessionId) {
    const cwd = projectWorkingDirectoryForSession(sessionId);
    const authenticatedSession = projectToolsetAuthenticatedSession(sessionId);
    return projectToolsetStatusForPath(cwd, { logicalSessionId: authenticatedSession.logicalSessionId });
  }

  async function rebuildAndRestartProjectService(workingDirectory, executionRoot = undefined) {
    const result = await projectToolsets.activateLatest(workingDirectory, { executionRoot });
    if (!result.ok) {
      const stageResult = result[result.stage];
      const detail = result.error
        || stageResult?.payload?.error
        || stageResult?.stderr
        || `Project service ${result.stage || "activation"} failed.`;
      const error = new Error(detail);
      error.code = "PROJECT_SERVICE_ACTIVATION_FAILED";
      error.activation = result;
      throw error;
    }
    return result;
  }

  async function projectWorktreeStatus(sessionId) {
    const reference = requireSessionReference(sessionId);
    const session = reference.metadata.session;
    const logical = (reference.logicalSessionId ? store.getLogicalSession(reference.logicalSessionId) : null)
      ?? store.getLogicalSessionByLegacySessionId(reference.sessionId)
      ?? await ensureLogicalRouteForProviderSession(session, reference.providerId);
    const [project, runtime, gitHubPush] = await Promise.all([
      gitWorkspaces.projectStatus(logical.logicalSessionId),
      projectToolsetStatus(sessionId),
      gitHubPushes.status({ workingDirectory: projectWorkingDirectoryForSession(sessionId) })
    ]);
    const activeWorkspacePath = resolve(projectWorkingDirectoryForSession(sessionId));
    project.worktrees = await Promise.all(project.worktrees.map(async (worktree) => {
      const isActiveWorkspace = worktree.availability === "available"
        && resolve(worktree.path) === activeWorkspacePath;
      const workspaceWithPushStatus = isActiveWorkspace ? { ...worktree, gitHubPush } : worktree;
      if (worktree.availability !== "available"
        || runtime.service.running !== true
        || runtime.service.verified !== true) {
        return { ...workspaceWithPushStatus, serviceContainsChanges: false };
      }
      const containsCommittedChanges = await gitWorkspaces.revisionContains(
        worktree.path, worktree.headOid, runtime.service.runningRevision
      );
      const sameWorktree = runtime.service.worktreePath
        && resolve(runtime.service.worktreePath) === resolve(worktree.path);
      const containsWorkingChanges = worktree.dirty !== true
        || (sameWorktree && runtime.service.dirty === true);
      return {
        ...workspaceWithPushStatus,
        serviceContainsChanges: containsCommittedChanges && containsWorkingChanges
      };
    }));
    return { project, ...runtime, gitHubPush };
  }

  return {
    projectWorkingDirectoryForSession, projectToolsetStatus,
    rebuildAndRestartProjectService, projectWorktreeStatus
  };
}
