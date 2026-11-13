import { createTaskDeletionBackgroundWork } from "./taskDeletionBackgroundWork.mjs";
import { TaskDeletionService } from "./taskDeletionService.mjs";
import { TaskExecutionOrchestrator } from "./taskExecutionOrchestrator.mjs";

export function createTaskExecutionComposition({
  store, inspectTaskWorktree, removeTaskDeletionWorktree,
  sessionApplicationService, artifactService, emitEvent,
  workService, sessionRuntimeReleaseService, sessionWorktrees,
  ensureTaskWorkspace, cancelTaskStartup, cancelTaskIntegration, cleanupTaskExecutionSpaces
}) {
  const taskDeletionService = new TaskDeletionService({
    store,
    backgroundWork: createTaskDeletionBackgroundWork({ store }),
    cancelStartup: cancelTaskStartup,
    cleanupExecutionSpaces: cleanupTaskExecutionSpaces,
    cancelIntegration: cancelTaskIntegration,
    stopSession: async sessionId => {
      const deliveries = store.selectAll("SELECT delivery_id,status FROM message_deliveries WHERE session_id=? AND status IN ('queued','dispatching','accepted','processing','delivery_unknown')", [sessionId]);
      for (const delivery of deliveries.filter(d => d.status === "queued")) store.updateMessageDelivery(delivery.delivery_id, { status: "cancelled" });
      for (const work of store.listAgentTasksForSession?.(sessionId, { statuses: ["queued"] }) ?? []) store.updateAgentTask(work.taskId, { status: "cancelled", cancellation: { actor: "task_deletion", reason: "TASK_DELETED" } });
      const session = store.getSession(sessionId);
      const active = ["running", "blocked"].includes(session?.status) || (store.listUnsettledSessionTurns?.(sessionId).length ?? 0) > 0;
      if (active) {
        await sessionApplicationService.interrupt(sessionId, { source: "task-deletion" });
        await sessionApplicationService.disconnectSession(sessionId, { source: "task-deletion" });
      }
      // Only a completed Provider stop/disconnect permits settling accepted work.
      for (const delivery of deliveries.filter(d => d.status !== "queued")) {
        if (!active) throw Object.assign(new Error("投递是否已执行尚未确认，需先恢复投递状态。"), { code: "SESSION_STATE_UNAVAILABLE" });
        store.updateMessageDelivery(delivery.delivery_id, { status: "cancelled" });
      }
      for (const work of store.listAgentTasksForSession?.(sessionId, { statuses: ["running"] }) ?? []) store.updateAgentTask(work.taskId, { status: "cancelled", cancellation: { actor: "task_deletion", reason: "TASK_DELETED" } });
    },
    inspectWorktree: (taskId, operation) => inspectTaskWorktree(taskId, operation),
    removeWorktree: (input) => removeTaskDeletionWorktree(input),
    deleteSession: async (sessionId, context) => {
      const result = await sessionApplicationService.deleteSessionForTaskDeletion(sessionId, context);
      if (result.providerDeleted === false) {
        console.warn(
          `[task-deletion] retired local Session after Provider cleanup failed session=${sessionId} provider=${result.providerId} code=${result.providerErrorCode ?? "unknown"}`
        );
      }
      return result;
    },
    handleArtifacts: ({ task, artifacts, disposition, actor, operationId }) => {
      if (actor?.type === "parent_session" && (disposition === "retain" || !artifacts.length)) return { disposition, preserved: true };
      if (actor?.type === "parent_session") return artifactService.disposeBoundArtifactsForTaskDeletion(
        { kind: "parent_task_deletion", operationId, actorId: actor.id, workId: task.work_id }, task.id, disposition);
      const delivery=actor?.type==="child_delivery" ? workService.childTaskDeliveryService.assertAuthority(actor.id) : null;
      return artifactService.disposeBoundArtifactsForTaskDeletion({
        kind:delivery?.actor.type === "shadow_session" ? "child_delivery" : "local_user",actorId:delivery?.actor.id ?? actor?.id,workId:task.work_id,
        ...(delivery ? {childDeliveryOperationId:delivery.operationId,
          revalidateUser:()=>workService.childTaskDeliveryService.assertAuthority(delivery.operationId)} : {})
      },task.id,disposition);
    },
    // Device grants are checked by the gateway before this user scope.
    authorize: ({ actor, task }) => actor?.type === "child_delivery"
      ? workService.childTaskDeliveryService?.authorizesCleanup(task.id,actor.id)===true
      : actor?.type === "parent_session" ? authorizesParentDeletion(store, actor.id, task)
      : actor?.type === "user" && (actor.id === "user:local-macos" || /^user:paired-device:[A-Za-z0-9_:-]{1,128}$/.test(String(actor.id ?? ""))),
    onChanged: (type, payload) => emitEvent(type, payload)
  });

  function restartTaskForEntityRoutes(taskId, context) {
    const task = workService.getTask(taskId);
    if (!task.current_session_id) {
      const error = new Error(`Task ${taskId} has no active Session to restart.`);
      error.code = "TASK_SESSION_NOT_FOUND";
      throw error;
    }
    return sessionApplicationService.restartSession(task.current_session_id, context);
  }

  async function setTaskArchivedForEntityRoutes(taskId, archived) {
    const task = store.setTaskArchived(taskId, archived);
    for (const session of store.listSessionsByTask(taskId)) {
      if (archived) {
        void sessionRuntimeReleaseService.request(session.id, "task-archived");
      } else {
        await sessionRuntimeReleaseService.restore(session.id);
      }
    }
    return task;
  }

  const taskExecutionOrchestrator = new TaskExecutionOrchestrator({
    getTask: (taskId) => store.getTask(taskId),
    getSession: (sessionId) => store.getSession(sessionId),
    getSessionRoute: (sessionId) => store.getLogicalSessionByLegacySessionId(sessionId),
    ensureWorkspace: ensureTaskWorkspace,
    switchWorkspace: (sessionId, worktreeId) => sessionWorktrees.switchWorkspace(
      sessionId, worktreeId, "Resume the bound Task in its restored Worktree."
    ),
    restoreSessionRoute: (sessionId) => {
      const logical = store.getLogicalSessionByLegacySessionId(sessionId);
      if (!logical) {
        const error = new Error("The bound Session has no logical Workspace route.");
        error.code = "TASK_SESSION_ROUTE_REQUIRED";
        throw error;
      }
      return store.restoreLogicalSessionWorkspace(logical.logicalSessionId);
    },
    resumeSession: (sessionId) => sessionApplicationService.resumeSession(sessionId, {
      source: "task-restore"
    }),
    updateTask: (taskId, patch) => store.updateTask(taskId, patch),
    onChanged: (type, payload) => emitEvent(type, payload)
  });
  return {
    taskDeletionService, taskExecutionOrchestrator,
    restartTaskForEntityRoutes, setTaskArchivedForEntityRoutes
  };
}

function authorizesParentDeletion(store, logicalSessionId, child) {
  const logical = store.getLogicalSession(logicalSessionId);
  const session = logical && store.getSession(logical.legacySessionId);
  const parent = session?.taskId && store.getTask(session.taskId);
  let ancestor = child, withinParent = false;
  const seen = new Set();
  while (ancestor?.parent_task_id && !seen.has(ancestor.id)) {
    seen.add(ancestor.id);
    if (ancestor.parent_task_id === parent?.id) { withinParent = true; break; }
    ancestor = store.getTask(ancestor.parent_task_id);
  }
  return Boolean(logical?.activeBinding?.state === "active" && !logical.archived && session && !session.archived && !session.deletedAt
    && session.sessionKind === "worker" && parent && !parent.parent_task_id && !parent.archived && !parent.deletion_status
    && parent.lifecycle_state !== "done" && withinParent && child.work_id === parent.work_id);
}
