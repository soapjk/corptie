import { inspectFailedStartupDeletion } from "./failedStartupDeletionInspection.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";

// Owns task worktree inspection and reclamation, independent of the HTTP runtime.
export function createTaskWorktreeOperations({ store, gitWorkspaces, projectApplicationService, emitEvent }) {
  function completedTaskStatus(status) {
    return ["done", "complete", "completed"].includes(String(status ?? ""));
  }

  async function inspectTaskWorktree(taskId) {
    const task = store.getTask(taskId);
    if (!task) {
      const error = new Error(`Task not found: ${taskId}`);
      error.code = "TASK_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    const sessions = store.listSessionsByTask(taskId);
    const session = sessions.find((candidate) => candidate.id === task.current_session_id)
      ?? sessions.at(-1)
      ?? null;
    if (!session) {
      const repositoryId = store.getTaskWorkspaceContext(task)?.repository?.id;
      if (!repositoryId) {
        return { status: "none", sessionId: null, worktree: null, canReclaim: false, blocker: null };
      }
      try {
        const project = await projectApplicationService.requireProject(repositoryId);
        const startup = store.selectOne(
          `SELECT worktree_id FROM work_session_startup_operations
           WHERE task_id=? AND worktree_id IS NOT NULL
           ORDER BY allocated_at DESC LIMIT 1`,
          [task.id]
        );
        const expectedBranch = `task/${String(task.id).includes(":") ? String(task.id).split(":").at(-1) : task.id}`;
        const knownWorktree = (startup?.worktree_id ? store.getGitWorktree(startup.worktree_id) : null)
          ?? store.listGitWorktrees(project.id).find((candidate) =>
            candidate.isMain !== true && candidate.branchName === expectedBranch
          )
          ?? null;
        if (!knownWorktree) return { status: "none", sessionId: null, repositoryId: project.id, worktree: null, canReclaim: false, blocker: null };
        const status = await gitWorkspaces.taskDeletionStatusForWorktree(project.id, knownWorktree.worktreeId);
        const worktree = status.worktrees[0] ?? null;
        if (!worktree) return { status: "none", sessionId: null, repositoryId: status.repositoryId, worktree: null, canReclaim: false, blocker: null };
        return {
          status: worktree.availability === "available" ? "available" : "unavailable",
          sessionId: null,
          repositoryId: status.repositoryId,
          worktree,
          canReclaim: false,
          blocker: worktree.availability === "available"
            ? (worktree.isMain ? "MAIN_WORKTREE" : (worktree.dirty ? "UNCOMMITTED_CHANGES" : (worktree.mergedIntoMain === true ? null : "NOT_MERGED_INTO_MAIN")))
            : "WORKTREE_UNAVAILABLE"
        };
      } catch (error) {
        return { status: "unavailable", sessionId: null, worktree: null, canReclaim: false, blocker: "WORKTREE_UNAVAILABLE", detail: error.message };
      }
    }
    const logical = store.getLogicalSessionByLegacySessionId(session.id);
    if (!logical?.activeBinding) {
      return inspectFailedStartupDeletion({ task, session, store, gitWorkspaces, isBusy: sessionHasActiveRun });
    }
    if (!logical.activeWorkspaceId) {
      return {
        status: session.rawStatus?.workspaceRetired ? "retired" : "none",
        sessionId: session.id,
        worktree: null,
        canReclaim: false,
        blocker: null,
        retiredWorkspace: session.rawStatus?.workspaceRetired ?? null
      };
    }
    let project;
    try {
      project = await gitWorkspaces.taskDeletionStatus(logical.logicalSessionId);
    } catch (error) {
      return {
        status: "unavailable",
        sessionId: session.id,
        worktree: null,
        canReclaim: false,
        blocker: "WORKTREE_UNAVAILABLE",
        detail: error.message
      };
    }
    const worktree = project.worktrees.find((candidate) => candidate.worktreeId === logical.activeWorkspaceId) ?? null;
    if (!worktree || worktree.availability !== "available") {
      return { status: "unavailable", sessionId: session.id, worktree, canReclaim: false, blocker: "WORKTREE_UNAVAILABLE" };
    }
    const boundSessions = worktree.sessions
      .map((binding) => binding.sessionId ? store.getSession(binding.sessionId) : null)
      .filter(Boolean);
    const hasBusySession = boundSessions.some((candidate) => sessionHasActiveRun(candidate));
    const hasIncompleteTask = boundSessions.some((candidate) => {
      const boundTask = candidate.taskId ? store.getTask(candidate.taskId) : null;
      return boundTask && !completedTaskStatus(boundTask.lifecycle_state);
    });
    let blocker = null;
    if (!completedTaskStatus(task.lifecycle_state)) blocker = "TASK_NOT_COMPLETED";
    else if (worktree.isMain) blocker = "MAIN_WORKTREE";
    else if (hasBusySession) blocker = "SESSION_BUSY";
    else if (hasIncompleteTask) blocker = "SHARED_WITH_ACTIVE_TASK";
    else if (worktree.dirty) blocker = "UNCOMMITTED_CHANGES";
    else if (worktree.mergedIntoMain !== true) blocker = "NOT_MERGED_INTO_MAIN";
    else if (worktree.pendingIntegration) blocker = "INTEGRATION_PENDING";
    return {
      status: "available",
      sessionId: session.id,
      repositoryId: project.repositoryId,
      worktree,
      canReclaim: blocker == null,
      blocker
    };
  }

  async function removeTaskDeletionWorktree({ inspection, force, confirmedBranchName }) {
    const worktree = inspection.worktree;
    const project = await projectApplicationService.requireProject(inspection.repositoryId);
    const logicalSessionIds = (worktree.sessions ?? []).map((item) => item.logicalSessionId);
    const cleanup = await gitWorkspaces.removeWorktreeForProject({
      repositoryId: inspection.repositoryId,
      workingDirectory: project.mainPath,
      sourceWorktreeId: worktree.worktreeId,
      ignoreLogicalSessionIds: logicalSessionIds,
      deleteBranch: true,
      forceDeleteUnmerged: force,
      acknowledgeIrrecoverable: force,
      confirmedBranchName
    });
    for (const logicalSessionId of logicalSessionIds) {
      const route = store.getLogicalSession(logicalSessionId);
      if (route?.activeWorkspaceId === worktree.worktreeId) {
        store.retireLogicalSessionWorkspace(logicalSessionId, worktree.worktreeId);
      }
    }
    return cleanup;
  }

  async function reclaimTaskWorktree(taskId) {
    const inspection = await inspectTaskWorktree(taskId);
    if (!inspection.canReclaim || !inspection.worktree || !inspection.sessionId) {
      const error = new Error("This Worktree is not safe to reclaim yet.");
      error.code = inspection.blocker ?? "WORKTREE_NOT_RECLAIMABLE";
      error.statusCode = 409;
      throw error;
    }
    const logical = store.getLogicalSessionByLegacySessionId(inspection.sessionId);
    const logicalSessionIds = inspection.worktree.sessions.map((item) => item.logicalSessionId);
    const cleanup = await gitWorkspaces.removeMergedWorktree({
      logicalSessionId: logical.logicalSessionId,
      sourceWorktreeId: inspection.worktree.worktreeId,
      ignoreLogicalSessionIds: logicalSessionIds,
      deleteBranch: true
    });
    for (const logicalSessionId of logicalSessionIds) {
      store.retireLogicalSessionWorkspace(logicalSessionId, inspection.worktree.worktreeId);
    }
    emitEvent("TaskWorktreeReclaimed", {
      taskId,
      sourceWorktreeId: inspection.worktree.worktreeId,
      logicalSessionIds,
      cleanup
    });
    return {
      ...(await inspectTaskWorktree(taskId)),
      cleanup
    };
  }

  return { inspectTaskWorktree, removeTaskDeletionWorktree, reclaimTaskWorktree };
}
