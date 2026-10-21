import { resolve } from "node:path";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { TaskWorktreeHierarchyService } from "./taskWorktreeHierarchyService.mjs";

export function createProjectWorktreeStatusReader({
  store, requireSessionReference, ensureLogicalRouteForProviderSession,
  projectToolsetAuthenticatedSession, projectToolsetStatusForPath,
  projectToolsets, gitWorkspaces, gitHubPushes, readLatestJob = () => null, readAutoFollow = () => ({ enabled: false, status: "off" })
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

  async function worktreeDetail(sessionId) {
    const reference = requireSessionReference(sessionId);
    const logical = (reference.logicalSessionId ? store.getLogicalSession(reference.logicalSessionId) : null)
      ?? store.getLogicalSessionByLegacySessionId(reference.sessionId);
    // A provider cwd is not proof of a managed Worktree binding. Never guess
    // another tree from the Task title or create a binding just to render UI.
    if (!logical?.repositoryId || !logical.activeWorkspaceId || !logical.activeBinding?.boundCwd) {
      return { attached: false, worktree: null, mainBranch: null };
    }
    let project = await (gitWorkspaces.sessionDetailInspection ?? gitWorkspaces.projectStatus).call(gitWorkspaces, logical.logicalSessionId);
    if(store.getTaskDeliveryBinding) {
      // Session-card inspections are bounded to main/current. Add the actual
      // parent from inventory, never guess it from a Provider working directory.
      const binding=store.selectOne(`SELECT p.worktree_id FROM task_delivery_worktrees c JOIN tasks t ON t.id=c.task_id
        JOIN task_delivery_worktrees p ON p.task_id=t.parent_task_id WHERE c.worktree_id=?`,[logical.activeWorkspaceId]);
      if(binding && !project.worktrees.some(w=>w.worktreeId===binding.worktree_id)) {
        const parent=store.getGitWorktree(binding.worktree_id);
        if(parent) {
          const fresh=gitWorkspaces.inspectSyncWorktree ? await gitWorkspaces.inspectSyncWorktree({repositoryId:logical.repositoryId,item:parent,allowResume:false}).catch(()=>({...parent,availability:"unavailable"})) : parent;
          project={...project,worktrees:[...project.worktrees,fresh]};
        }
      }
      project=await new TaskWorktreeHierarchyService({store}).decorateInspection({...project,repositoryId:logical.repositoryId});
    }
    const worktree = project.worktrees.find(row => row.worktreeId === logical.activeWorkspaceId);
    const main = project.worktrees.find(row => row.worktreeId === project.mainWorktreeId);
    const baseline=worktree?.hierarchy?.parentWorktreeId ? project.worktrees.find(row=>row.worktreeId===worktree.hierarchy.parentWorktreeId) : main;
    if (!worktree) throw Object.assign(new Error("The current Worktree binding is unavailable."), { code: "WORKTREE_NOT_FOUND", statusCode: 409 });
    const associated = [
      ...(store.listLogicalSessionsByWorkspaceId?.(worktree.worktreeId) ?? [logical]),
      ...(baseline ? store.listLogicalSessionsByWorkspaceId?.(baseline.worktreeId) ?? [] : [])
    ];
    const busy = associated.some(row => sessionHasActiveRun(store.getSession(row.legacySessionId))
      || store.hasUnsettledSessionRuntimeWork?.(row.legacySessionId))
      || sessionHasActiveRun(reference.metadata.session);
    const blockedReason = worktree.isMain ? "MAIN_WORKTREE"
      : worktree.availability !== "available" || !baseline || baseline.availability !== "available" ? "WORKTREE_UNAVAILABLE"
      : worktree.operationState || baseline.operationState || worktree.conflictFiles?.length || baseline.conflictFiles?.length ? "GIT_OPERATION_IN_PROGRESS"
      : worktree.isLocked || baseline.isLocked ? "WORKTREE_LOCKED"
      : worktree.isDetached || !worktree.branchName || !baseline.branchName ? "DETACHED_HEAD"
      : busy ? "SESSION_BUSY"
      : worktree.dirty !== false || baseline.dirty !== false ? "UNCOMMITTED_CHANGES"
      : null;
    const latest = readLatestJob(logical.repositoryId);
    const job = ["awaiting_confirmation", "queued", "running", "paused", "failed", "cancellation_requested", "replanning"].includes(latest?.status)
      && latest?.plan?.items?.some(item => item.worktreeId === worktree.worktreeId) ? latest : null;
    return { attached: true, workId:reference.metadata.session.workId ?? null, repositoryId: logical.repositoryId, mainWorktreeId: project.mainWorktreeId, job,
      autoFollow: readAutoFollow(worktree.worktreeId),
      mainBranch: main?.branchName ?? project.mainBranch ?? null, blockedReason,
      worktree: { worktreeId: worktree.worktreeId, path: worktree.path, branchName: worktree.branchName,
        hierarchy:worktree.hierarchy ?? null,
        isMain: worktree.isMain, availability: worktree.availability, dirty: worktree.dirty ?? null,
        changedFiles: (worktree.changedFiles ?? []).slice(0, 20), changedFileCount: worktree.changedFiles?.length ?? 0,
        aheadOfMain: worktree.aheadOfMain ?? null,
        behindMain: worktree.behindMain ?? null, operationState: worktree.operationState ?? null,
        conflictFiles: (worktree.conflictFiles ?? []).slice(0, 100) } };
  }

  async function projectWorktreeStatus(sessionId, options = {}) {
    if (options.detailCard) return worktreeDetail(sessionId);
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
    rebuildAndRestartProjectService, projectWorktreeStatus, worktreeDetail
  };
}
