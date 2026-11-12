import { randomUUID } from "node:crypto";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";

const FORCEABLE_RISKS = new Set(["UNCOMMITTED_CHANGES", "UNTRACKED_FILES", "NOT_MERGED_INTO_MAIN", "NOT_DELIVERED_TO_PARENT"]);
const WORKTREE_ONLY_BLOCKERS = new Set(["MAIN_WORKTREE", "SHARED_WITH_ACTIVE_TASK", "GIT_OPERATION_IN_PROGRESS", "UNRESOLVED_CONFLICTS", "WORKTREE_LOCKED"]);
const ARTIFACT_DISPOSITIONS = new Set(["delete", "work", "retain"]);

export class TaskDeletionService {
  constructor(options = {}) {
    this.store = options.store;
    this.inspectWorktree = options.inspectWorktree;
    this.removeWorktree = options.removeWorktree;
    this.deleteSession = options.deleteSession;
    this.handleArtifacts = options.handleArtifacts;
    this.authorize = options.authorize;
    this.onChanged = options.onChanged ?? (() => {});
    this.stopSession = options.stopSession;
    this.cancelStartup = options.cancelStartup;
    this.cancelIntegration = options.cancelIntegration;
    this.cleanupExecutionSpaces = options.cleanupExecutionSpaces;
    this.prepareChildDelivery = options.prepareChildDelivery;
    this.inFlight = new Map();
    this.waitingOn = new Map();
    if (!this.store || typeof this.store.finalizeTaskDeletion !== "function"
      || typeof this.store.listTaskDeletionBlockingAssociations !== "function"
      || typeof this.store.listSessionsByTask !== "function") {
      throw new TypeError("TaskDeletionService requires a Store with deletion support.");
    }
    if (typeof this.authorize !== "function") {
      throw new TypeError("TaskDeletionService requires authorize().");
    }
    for (const method of ["inspectWorktree", "removeWorktree", "deleteSession", "handleArtifacts"]) {
      if (typeof this[method] !== "function") throw new TypeError(`TaskDeletionService requires ${method}().`);
    }
  }

  async requestAfterChildDelivery(operation) {
    if (operation.phase !== "cleanup" || !operation.progress.codeDelivered || !operation.progress.artifactsDelivered) {
      if (!this.prepareChildDelivery) throw coded("CAPABILITY_UNAVAILABLE", "自动交付服务尚未装配。", 503);
      operation = await this.prepareChildDelivery(operation.operationId);
      if (operation.phase !== "cleanup" || !operation.progress.codeDelivered || !operation.progress.artifactsDelivered) {
        return { accepted: true, pendingDelivery: true, deliveryOperationId: operation.operationId, operation: null };
      }
    }
    return this.request(operation.taskId,{mode:"safe",deleteWorktree:true,artifactDisposition:"retain",
      idempotencyKey:`child-delivery:${operation.operationId}:cleanup:${operation.progress.cleanupAttempt ?? 0}`},
    {type:"child_delivery",id:operation.operationId});
  }

  async request(taskId, input = {}, actor = null) {
    const requestedKey = String(input.idempotencyKey ?? "").trim();
    if (requestedKey) {
      const replay = this.store.getTaskDeletionOperationByKey(taskId, requestedKey);
      if (replay) {
        if (replay.state !== "failed" || !replay.retryable) return { accepted: true, operation: replay, idempotentReplay: true };
        const original = replay.input;
        if (original.actor?.type !== actor?.type || original.actor?.id !== actor?.id) {
          throw coded("TASK_DELETE_FORBIDDEN", "Only the original actor may resume this deletion.", 403);
        }
        // Resume the saved intent, never adopt new disposal options under an old key.
        for (const field of ["deleteWorktree", "artifactDisposition", "acknowledgeDataLoss", "stopRunning", "cancelStartup", "deleteAssociatedTasks", "cancelIntegration"]) {
          if (input[field] !== undefined && input[field] !== original[field]) {
            throw coded("TASK_DELETE_IDEMPOTENCY_CONFLICT", "Deletion options changed; use a new request key.", 409);
          }
        }
        await this.inFlight.get(replay.operationId);
        const plan = await this.inspect(taskId, actor, replay.operationId);
        this.#assertDeletionAllowed(plan, original, true);
        const operation = this.store.beginTaskDeletionOperation(taskId, original, requestedKey, { retryFailed: true });
        if (["queued", "running"].includes(operation.state)) this.#schedule(operation.operationId);
        return { accepted: true, operation, idempotentReplay: true };
      }
    }
    const plan = await this.inspect(taskId, actor);
    this.#assertDeletionAllowed(plan, input, true);
    const operation = this.store.beginTaskDeletionOperation(
      taskId,
      { mode: "force", deleteWorktree: input.deleteWorktree !== false,
        artifactDisposition: input.artifactDisposition ?? "delete", acknowledgeDataLoss: input.acknowledgeDataLoss === true,
        stopRunning: input.stopRunning === true, cancelStartup: input.cancelStartup === true,
        deleteAssociatedTasks: input.deleteAssociatedTasks === true, cancelIntegration: input.cancelIntegration === true,
        actor: { type: actor?.type, id: actor?.id },
        resumeCleanup: plan.inspection?.pendingCleanup ?? null,
        target: this.#target(taskId, plan) },
      requestedKey || `task-delete:${randomUUID()}`
    );
    this.onChanged("TaskChanged", {
      action: "deletion-started",
      entity: this.store.getTask(taskId),
      operation
    });
    if (["queued", "running"].includes(operation.state)) this.#schedule(operation.operationId);
    return { accepted: true, operation, idempotentReplay: false };
  }

  getOperation(operationId) {
    const operation = this.store.getTaskDeletionOperation(operationId);
    if (!operation) throw coded("TASK_DELETE_OPERATION_NOT_FOUND", "Task deletion operation was not found.", 404);
    return operation;
  }

  recoverInterruptedDeletions() {
    // Delivery-owned deletions resume only after Artifact/Git recovery and
    // revalidation by their coordinator, never as independent startup work.
    const operations = this.store.listRecoverableTaskDeletionOperations().filter(operation => operation.input?.actor?.type !== "child_delivery");
    for (const operation of operations) this.#schedule(operation.operationId);
    return operations.length;
  }

  resumeChildDeliveryDeletion(operationId, deliveryId) {
    const operation = this.getOperation(operationId);
    if (operation.input?.actor?.type !== "child_delivery" || operation.input.actor.id !== deliveryId) {
      throw coded("TASK_DELETE_FORBIDDEN", "Deletion is not owned by this delivery.", 403);
    }
    return this.#schedule(operationId);
  }

  #schedule(operationId) {
    if (this.inFlight.has(operationId)) return this.inFlight.get(operationId);
    const promise = this.#drive(operationId).finally(() => this.inFlight.delete(operationId));
    this.inFlight.set(operationId, promise);
    return promise;
  }

  async #drive(operationId) {
    let operation = this.getOperation(operationId);
    if (["succeeded", "failed"].includes(operation.state)) return operation;
    operation = this.store.updateTaskDeletionOperation(operationId, {
      state: "running",
      stage: "cleanup",
      startedAt: operation.startedAt ?? new Date().toISOString(),
      attempt: operation.state === "running" ? operation.attempt + 1 : operation.attempt
    });
    try {
      const result = await this.delete(operation.taskId, operation.input,
        operation.input.actor, operation.operationId);
      operation = this.store.updateTaskDeletionOperation(operationId, {
        state: "succeeded",
        stage: "completed",
        result,
        errorCode: null,
        errorMessage: null,
        retryable: false,
        completedAt: new Date().toISOString()
      });
    } catch (error) {
      if (this.store.getTask(operation.taskId)) this.store.markTaskDeletion(operation.taskId, "delete_failed", actionableFailure(error));
      operation = this.store.updateTaskDeletionOperation(operationId, {
        state: "failed",
        stage: error?.stage ?? "cleanup",
        errorCode: error?.code ?? "TASK_DELETE_FAILED",
        errorMessage: actionableFailure(error),
        retryable: true,
        completedAt: new Date().toISOString()
      });
    }
    this.onChanged("TaskChanged", {
      action: operation.state === "succeeded" ? "deleted" : "deletion-failed",
      entity: this.store.getTask(operation.taskId) ?? { id: operation.taskId },
      operation
    });
    return operation;
  }

  async inspect(taskId, actor = null, operationId = null) {
    const item = this.store.getTask(taskId);
    if (!item) throw coded("TASK_NOT_FOUND", `Task not found: ${taskId}`, 404);
    if (await this.authorize({ actor, task: item, operation: "delete" }) !== true) {
      throw coded("TASK_DELETE_FORBIDDEN", "You do not have permission to delete this Task.", 403);
    }
    const associations = this.store.listTaskDeletionBlockingAssociations(taskId);
    const artifacts = Array.isArray(associations?.artifacts) ? associations.artifacts : [];
    const associatedSessionCount = this.store.listSessionsByTask(taskId).length;
    const blockers = [];
    if (this.store.listSessionsByTask(taskId).some(session => sessionHasActiveRun(session)
      || this.store.getSessionRuntimeBlocker?.(session.id, { includeQueued: true }))) {
      blockers.push({ code: "SESSION_BUSY", message: "会话正在执行，可选择停止后删除。", action: "stopRunning" });
    }
    const owningIntegrationJob = this.store.getActiveWorktreeIntegrationJobForConflictTask?.(taskId) ?? null;
    if (owningIntegrationJob) {
      blockers.push({
        code: "ACTIVE_WORKTREE_INTEGRATION_JOB",
        message: `集成作业 ${owningIntegrationJob.id}（${owningIntegrationJob.status}/${owningIntegrationJob.phase}）占用资源，可请求取消后重试。`,
        jobId: owningIntegrationJob.id, status: owningIntegrationJob.status, phase: owningIntegrationJob.phase,
        action: "cancelIntegration", canResolve: typeof this.cancelIntegration === "function"
      });
    }
    const currentOperation = operationId && this.store.getTaskDeletionOperation(operationId);
    const previousRow = !operationId && this.store.selectOne?.(
      "SELECT operation_id FROM task_deletion_operations WHERE task_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1", [taskId]);
    const previous = previousRow && this.store.getTaskDeletionOperation(previousRow.operation_id);
    const pending = currentOperation?.result?.cleanup ?? currentOperation?.input?.resumeCleanup ?? previous?.result?.cleanup;
    if (!item.deletion_worktree_removed_at && pending?.worktreeRemoved) {
      const target = (currentOperation ?? previous).input.target;
      if (target) {
      return deletionPlan(item, { status: "available", repositoryId: target.repositoryId, pendingCleanup: pending,
        worktree: { worktreeId: target.worktreeId, path: target.path, branchName: target.branchName,
          headOid: target.headOid, dirty: false, mergedIntoMain: true, sessions: [] } }, [], blockers, associatedSessionCount, artifacts);
      }
    }
    if (item.deletion_worktree_removed_at) {
      return deletionPlan(item, { status: "removed", worktree: null }, [], blockers, associatedSessionCount, artifacts);
    }
    const activeStart = this.store.selectOne(
      `SELECT startup_operation_id FROM work_session_startup_operations WHERE task_id=?
       AND state IN ('allocated','worktree_prepared','session_bound','provider_bound','compensating') LIMIT 1`,
      [taskId]
    );
    const sandboxStart = this.store.selectOne?.("SELECT execution_space_id FROM execution_spaces WHERE task_id=? AND status IN ('pending','preparing','binding') LIMIT 1", [taskId]);
    if (activeStart || sandboxStart || item.creation_state === "pending") {
      blockers.push({ code: "START_IN_PROGRESS", message: "Task 正在启动，可选择中断启动后删除。", action: "cancelStartup" });
    }
    const inspection = await this.inspectWorktree(taskId);
    const risks = contentRisks(inspection?.worktree);
    blockers.push(...hardBlockers(inspection).map(blocker => blocker.code === "ACTIVE_WORKTREE_INTEGRATION_JOB" && inspection.integrationJob
      ? { ...blocker, jobId: inspection.integrationJob.id, status: inspection.integrationJob.status, phase: inspection.integrationJob.phase,
          message: `集成作业 ${inspection.integrationJob.id}（${inspection.integrationJob.status}/${inspection.integrationJob.phase}）占用此 Worktree，可请求取消后重试。`,
          action: "cancelIntegration", canResolve: typeof this.cancelIntegration === "function" } : blocker));
    if (inspection.integrationJob && !blockers.some(b => b.jobId === inspection.integrationJob.id)) blockers.push({
      code: "ACTIVE_WORKTREE_INTEGRATION_JOB", jobId: inspection.integrationJob.id,
      status: inspection.integrationJob.status, phase: inspection.integrationJob.phase,
      message: `集成作业 ${inspection.integrationJob.id}（${inspection.integrationJob.status}/${inspection.integrationJob.phase}）占用此 Worktree。`,
      action: "cancelIntegration", canResolve: typeof this.cancelIntegration === "function"
    });
    const plan = deletionPlan(item, inspection, risks, blockers, associatedSessionCount, artifacts);
    plan.childTaskIds = this.#children(taskId);
    plan.associatedTaskIds = this.#associatedTasks(plan.worktree?.worktreeId, taskId);
    if (plan.associatedTaskIds.length && !blockers.some(b => b.code === "SHARED_WITH_ACTIVE_TASK")) blockers.push({ code: "SHARED_WITH_ACTIVE_TASK", message: "可选择一并删除共用此 Worktree 的关联任务。", action: "deleteAssociatedTasks" });
    plan.status = blockers.length ? "blocked" : risks.length ? "risky" : "safe";
    return plan;
  }

  #children(taskId) {
    return (this.store.selectAll?.("SELECT id FROM tasks WHERE parent_task_id=? AND COALESCE(deletion_status,'')<>'deleted' ORDER BY id", [taskId]) ?? []).map(t => t.id);
  }

  #associatedTasks(worktreeId, taskId) {
    if (!worktreeId) return [];
    const ids = new Set((this.store.selectAll?.("SELECT task_id AS id FROM task_delivery_worktrees WHERE worktree_id=?", [worktreeId]) ?? []).map(t => t.id));
    for (const route of this.store.listLogicalSessionsByWorkspaceId?.(worktreeId) ?? []) ids.add(route.taskId ?? this.store.getSession(route.legacySessionId)?.taskId);
    return [...ids].filter(id => id && id !== taskId && this.store.getTask(id));
  }

  #target(taskId, plan) {
    const task = this.store.getTask(taskId);
    const binding = this.store.getTaskDeliveryBinding?.(taskId);
    return { version: 1, taskId, parentTaskId: task.parent_task_id ?? null,
      repositoryId: plan.inspection?.repositoryId ?? null,
      worktreeId: plan.worktree?.worktreeId ?? null, path: plan.worktree?.path ?? null,
      branchName: plan.worktree?.branchName ?? null, headOid: plan.inspection?.worktree?.headOid ?? null,
      statusSummary: plan.inspection?.worktree?.statusSummary ?? "",
      bindingRevision: binding?.binding_revision ?? null,
      sessionIds: this.store.listSessionsByTask(taskId).map(s => s.id).sort(),
      artifactIds: plan.artifacts.map(a => a.artifactId).sort() };
  }

  async delete(taskId, input = {}, actor = null, operationId = null) {
    let plan = await this.inspect(taskId, actor, operationId);
    this.#assertDeletionAllowed(plan, input, true);
    // Freeze scheduling before asking a Provider/startup operation to stop.
    this.store.markTaskDeletion(taskId, "deleting", null);
    if (input.cancelIntegration) {
      for (const blocker of plan.blockers.filter(b => b.code === "ACTIVE_WORKTREE_INTEGRATION_JOB")) {
        if (blocker.jobId && this.cancelIntegration) await this.cancelIntegration(blocker.jobId, { actor, taskId });
      }
    }
    if (input.cancelStartup && this.cancelStartup) await this.cancelStartup(taskId);
    if (input.stopRunning && this.stopSession) {
      for (const session of this.store.listSessionsByTask(taskId)) {
        if (sessionHasActiveRun(session) || this.store.getSessionRuntimeBlocker?.(session.id, { includeQueued: true })) await this.stopSession(session.id);
      }
    }
    const related = [...new Set([...this.#children(taskId), ...(input.deleteAssociatedTasks ? this.#associatedTasks(plan.worktree?.worktreeId, taskId) : [])])];
    // Authorize the complete set before deleting any member. A parent Session
    // cannot turn a shared-worktree option into authority over an unrelated Task.
    for (const id of related) {
      const task = this.store.getTask(id);
      if (task && await this.authorize({ actor, task, operation: "delete" }) !== true) throw coded("TASK_DELETE_FORBIDDEN", "无权删除关联任务。", 403);
    }
    for (const id of related) {
      const task = this.store.getTask(id);
      if (!task) continue;
      const binding = this.store.getTaskDeliveryBinding?.(id);
      const shared = binding ? binding.worktree_id === plan.worktree?.worktreeId
        : (this.store.listLogicalSessionsByWorkspaceId?.(plan.worktree?.worktreeId) ?? []).some(route =>
            (route.taskId ?? this.store.getSession(route.legacySessionId)?.taskId) === id);
      const accepted = await this.request(id, { ...input, deleteWorktree: shared ? false : input.deleteWorktree,
        deleteAssociatedTasks: false, idempotencyKey: `${operationId ?? taskId}:cascade:${id}` }, actor);
      const nextId = accepted.operation.operationId;
      if (operationId) {
        const seen = new Set([operationId]);
        let dependency = nextId;
        while (dependency) {
          if (seen.has(dependency)) throw coded("TASK_DELETE_IN_PROGRESS", `关联任务已有交叉删除作业 ${nextId}，请在该作业结算后重试。`, 409);
          seen.add(dependency); dependency = this.waitingOn.get(dependency);
        }
        this.waitingOn.set(operationId, nextId);
      }
      try { await this.#schedule(nextId); }
      finally { if (operationId) this.waitingOn.delete(operationId); }
      const result = this.getOperation(accepted.operation.operationId);
      if (result.state !== "succeeded") throw coded(result.errorCode ?? "TASK_DELETE_FAILED", result.errorMessage, 409);
    }
    plan = await this.inspect(taskId, actor, operationId);
    this.#assertDeletionAllowed(plan, input);
    // Resolve the same Task's live resource binding; code/version changes do
    // not require a second confirmation. Never accept a caller-provided path.
    const target = this.#target(taskId, plan);
    input = { ...input, target };
    if (operationId && this.store.db) {
      this.store.db.run("UPDATE task_deletion_operations SET input_json=? WHERE operation_id=? AND task_id=?", [JSON.stringify(input), operationId, taskId]);
      this.store.scheduleSave?.();
    }
    const deleteWorktree = input.deleteWorktree !== false;
    const artifactDisposition = input.artifactDisposition ?? "delete";

    let cleanup = null;
    const deletedSessionIds = [];
    try {
      if (deleteWorktree && (plan.worktree || (operationId && input.target?.worktreeId
        && !this.store.getTask(taskId).deletion_worktree_removed_at))) {
        cleanup = await this.removeWorktree({ taskId, inspection: plan.inspection,
          force: true,
          operationId, target: input.target });
        this.store.markTaskWorktreeRemoved(taskId);
      }
      for (const session of this.store.listSessionsByTask(taskId)) {
        await this.deleteSession(session.id, {
          source: "task-deletion",
          taskId
        });
        deletedSessionIds.push(session.id);
      }
      await this.cleanupExecutionSpaces?.(taskId);
      const artifactCleanup = await this.handleArtifacts({
        task: this.store.getTask(taskId),
        artifacts: plan.artifacts,
        disposition: artifactDisposition,
        operationId, actor
      });
      const resources = {
        ...this.store.finalizeTaskDeletion(taskId),
        deletedSessionIds,
        artifactCleanup
      };
      this.onChanged("TaskChanged", { action: "deleted", entity: { id: taskId } });
      return { ok: true, taskId, cleanup, resources };
    } catch (error) {
      if (this.store.getTask(taskId)) {
        this.store.markTaskDeletion(taskId, "delete_failed", actionableFailure(error));
      }
      throw coded(
        error?.code ?? "TASK_DELETE_FAILED",
        `删除未完成，已保留可识别状态，可安全重试：${actionableFailure(error)}`,
        error?.statusCode ?? 409
      );
    }
  }

  #assertDeletionAllowed(plan, input, preparing = false) {
    if (!ARTIFACT_DISPOSITIONS.has(input.artifactDisposition ?? "delete")) throw coded("TASK_ARTIFACT_DISPOSITION_INVALID", "无效的 Artifact 处理方式。", 400);
    const blockers = plan.blockers.filter(blocker => {
      if (input.deleteWorktree === false && WORKTREE_ONLY_BLOCKERS.has(blocker.code)) return false;
      if (["GIT_OPERATION_IN_PROGRESS", "UNRESOLVED_CONFLICTS", "WORKTREE_LOCKED"].includes(blocker.code)) return false;
      if (preparing && input.cancelStartup && this.cancelStartup && plan.blockers.some(b => b.code === "START_IN_PROGRESS") && ["WORKTREE_UNAVAILABLE", "NO_WORKSPACE_ROUTE"].includes(blocker.code)) return false;
      if (preparing && blocker.code === "SESSION_BUSY" && input.stopRunning && this.stopSession) return false;
      if (preparing && blocker.code === "START_IN_PROGRESS" && input.cancelStartup && this.cancelStartup) return false;
      if (preparing && blocker.code === "SHARED_WITH_ACTIVE_TASK" && input.deleteAssociatedTasks) return false;
      if (preparing && blocker.code === "ACTIVE_WORKTREE_INTEGRATION_JOB" && input.cancelIntegration && this.cancelIntegration && blocker.jobId) return false;
      return true;
    });
    if (blockers.length) throw coded(blockers[0].code, blockers[0].message, 409, { deletion: { ...plan, blockers } });
  }

}

function deletionPlan(item, inspection, risks, blockers, associatedSessionCount, artifacts = []) {
  return {
    taskId: item.id,
    parentTaskId: item.parent_task_id ?? null,
    status: blockers.length > 0 ? "blocked" : (risks.length > 0 ? "risky" : "safe"),
    retryable: true,
    associatedSessionCount,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      title: artifact.title,
      visibility: artifact.visibility,
      status: artifact.status
    })),
    inspection,
    worktree: inspection?.worktree ? {
      worktreeId: inspection.worktree.worktreeId,
      path: inspection.worktree.canonicalPath || inspection.worktree.path,
      branchName: inspection.worktree.branchName,
      isMain: inspection.worktree.isMain === true,
      dirty: inspection.worktree.dirty === true,
      mergedIntoMain: inspection.worktree.mergedIntoMain === true,
      aheadOfMain: Number(inspection.worktree.aheadOfMain) || 0
    } : null,
    risks,
    blockers
  };
}

function contentRisks(worktree) {
  if (!worktree) return [];
  const lines = String(worktree.statusSummary ?? "").split(/\r?\n/).filter(Boolean);
  const untrackedFiles = lines.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
  const trackedChanges = lines.filter((line) => !line.startsWith("?? "));
  const risks = [];
  if (trackedChanges.length > 0) risks.push({ code: "UNCOMMITTED_CHANGES", message: "Worktree 存在未提交修改。", files: trackedChanges });
  if (untrackedFiles.length > 0) risks.push({ code: "UNTRACKED_FILES", message: "Worktree 存在未跟踪文件。", files: untrackedFiles });
  if ((worktree.deliveryComparison?.delivered ?? worktree.mergedIntoMain) !== true) risks.push({
    code: worktree.deliveryComparison ? "NOT_DELIVERED_TO_PARENT" : "NOT_MERGED_INTO_MAIN",
    message: worktree.deliveryComparison ? `子分支有 ${worktree.deliveryComparison.commitCount} 个独有提交尚未交付到父分支。`
      : `Worktree 有 ${Number(worktree.aheadOfMain) || 0} 个提交尚未合并到目标主分支。`,
    commitCount: worktree.deliveryComparison?.commitCount ?? (Number(worktree.aheadOfMain) || 0)
  });
  return risks;
}

function hardBlockers(inspection) {
  if (!inspection || ["none", "retired", "removed"].includes(inspection.status)) return [];
  const code = inspection.blocker;
  if (!code || FORCEABLE_RISKS.has(code) || code === "INTEGRATION_PENDING" || code === "TASK_NOT_COMPLETED") return [];
  const messages = {
    MAIN_WORKTREE: "关联目录是目标主 Worktree，禁止删除共享主目录或主分支。",
    SESSION_BUSY: "关联 Session 仍在运行。请先等待或终止执行。",
    SHARED_WITH_ACTIVE_TASK: "该 Worktree 仍被其他 Task 使用，禁止删除共享资源。",
    WORKTREE_UNAVAILABLE: "关联 Worktree 当前不可访问。请恢复磁盘或修复 Git Worktree 后重试。",
    NO_WORKSPACE_ROUTE: "Task 的 Workspace 路由已失效，无法确认专属资源边界。",
    GIT_OPERATION_IN_PROGRESS: "该工作区仍有未完成的 Git 操作，请先安全完成或中止后重试。",
    UNRESOLVED_CONFLICTS: "该工作区仍有未解决的冲突，请先处理后重试。",
    WORKTREE_LOCKED: "该工作区已被 Git 锁定，请确认锁定原因后安全处理。",
    WORKTREE_BRANCH_AMBIGUOUS: "无法确定专属分支，不能安全确认删除范围。"
  };
  return [{ code, message: messages[code] ?? inspection.detail ?? "无法确认关联资源可安全删除。" }];
}

function coded(code, message, statusCode, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function actionableFailure(error) {
  return String(error?.message ?? error ?? "未知错误").replace(/\s+/g, " ").trim().slice(0, 1000);
}
