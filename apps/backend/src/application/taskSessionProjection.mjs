import { taskExecutionPatch } from "./taskAcceptance.mjs";

// Projects execution status only; Task completion stays behind acceptance and
// explicit completion commands. Owns per-Session memory extraction ordering.
export function createTaskSessionProjection({ store, memoryExtractor, emitEvent, sessionWithLogicalWorkspace }) {
  const taskMemoryExtractions = new Map();

  // Session 生命周期只投影到 Task.execution_status。Task.lifecycle_state
  // 必须由独立验收评估产生，绝不能从一次 turn/session 落定推断。
  function settleEntityTaskFromSession(session, { extractMemory = true } = {}) {
    if (!session?.id) return null;
    const task = store.getTaskBySessionId(session.id);
    // Replaced Worker Sessions remain queryable for audit, but only the current
    // binding may project lifecycle state back onto the Task.
    if (task && task.current_session_id !== session.id) return task;
    if (extractMemory) scheduleTaskMemoryExtraction(session, task);
    if (!task) return null;
    const patch = taskExecutionPatch(task, session.status);
    if (!patch) return task;
    const executionChanged = patch.executionStatus !== (task.execution_status ?? "idle");
    if (!executionChanged) return task;
    if (process.env.CORPTIE_DEBUG_STATE_SYNC) {
      console.log(`[settle] task=${task.id} session=${session.id} session.status=${session.status} ` +
        `task.lifecycle=${task.lifecycle_state} ` +
        `task.exec=${task.execution_status}->${patch.executionStatus}`);
    }
    store.updateTask(task.id, patch);
    const updated = store.getTask(task.id);
    emitEvent("TaskChanged", { action: "execution-status-updated", entity: updated });
    return updated;
  }

  function scheduleTaskMemoryExtraction(session, task) {
    if (session.sessionKind && !["worker", "workChat", "assistantChat"].includes(session.sessionKind)) return;
    const previous = taskMemoryExtractions.get(session.id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => memoryExtractor.extractFromSession(session.id)).then((memories) => {
      if (memories.length === 0 || !task) return;
      const updated = store.updateTask(task.id, {});
      emitEvent("TaskChanged", {
        action: "memory-updated",
        entity: updated,
        memoryIds: memories.map((memory) => memory.id)
      });
    }).catch((error) => {
      console.error(`[task-memory] extraction failed for ${task?.id ?? session.id}: ${error?.message ?? error}`);
    }).finally(() => {
      if (taskMemoryExtractions.get(session.id) === operation) {
        taskMemoryExtractions.delete(session.id);
      }
    });
    taskMemoryExtractions.set(session.id, operation);
  }

  function settleTaskForWorkspaceContinuation(transitionId) {
    const transition = store.getWorkspaceTransition(transitionId);
    const logical = transition ? store.getLogicalSession(transition.logicalSessionId) : null;
    const session = logical?.legacySessionId ? store.getSession(logical.legacySessionId) : null;
    if (!session) return null;
    return settleEntityTaskFromSession(sessionWithLogicalWorkspace(session, logical));
  }


  // 启动对账：历史落定（修复上线前就已完成的会话）不会重新触发事件，
  // 此处把每个已绑定当前活跃 session 的 Task 状态对齐到 session 状态。
  function reconcileEntityTasksAtStartup() {
    let aligned = 0;
    for (const task of store.listTasks({ includeCompleted: false })) {
      if (!task.current_session_id) continue;
      const session = store.getSession(task.current_session_id);
      if (!session) continue;
      const updated = settleEntityTaskFromSession(session, { extractMemory: false });
      if (updated && updated.execution_status !== task.execution_status) aligned += 1;
    }
    if (aligned > 0) {
      console.log(`[entity-task] startup reconcile aligned ${aligned} Task(s)`);
    }
  }

  return {
    settleEntityTaskFromSession, settleTaskForWorkspaceContinuation, reconcileEntityTasksAtStartup,
    get pendingMemoryCount() { return taskMemoryExtractions.size; }
  };
}
