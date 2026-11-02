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
    this.inFlight = new Map();
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
    if(operation.phase!=="cleanup" || !operation.progress.codeDelivered || !operation.progress.artifactsDelivered) {
      throw coded("CHILD_DELIVERY_INCOMPLETE","交付尚未完成，不能清理。",409);
    }
    return this.request(operation.taskId,{mode:"safe",deleteWorktree:true,artifactDisposition:"retain",
      idempotencyKey:`child-delivery:${operation.operationId}:cleanup:${operation.progress.cleanupAttempt ?? 0}`},
    {type:"child_delivery",id:operation.operationId});
  }

  async request(taskId, input = {}, actor = null) {
    if (actor?.type === "parent_session" && (input.mode !== "safe" || input.artifactDisposition !== "retain" || input.deleteWorktree !== true)) {
      throw coded("TASK_DELETE_FORBIDDEN", "Parent Sessions may request only safe deletion with Artifact retention.", 403);
    }
    const requestedKey = String(input.idempotencyKey ?? "").trim();
    if (requestedKey) {
      const replay = this.store.getTaskDeletionOperationByKey(taskId, requestedKey);
      if (replay) return { accepted: true, operation: replay, idempotentReplay: true };
    }
    const plan = await this.inspect(taskId, actor);
    this.#assertDeletionAllowed(plan, input);
    const operation = this.store.beginTaskDeletionOperation(
      taskId,
      { mode: input.mode ?? "safe", deleteWorktree: input.deleteWorktree !== false,
        artifactDisposition: input.artifactDisposition ?? "delete", acknowledgeDataLoss: input.acknowledgeDataLoss === true,
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
      if (!operation.input.target) throw coded("TASK_DELETE_RECONFIRM_REQUIRED", "旧删除作业缺少精确目标，请重新检查并确认删除。", 409);
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
    if (actor?.type === "parent_session" && artifacts.length) return deletionPlan(item, null, [], [{ code: "CHILD_ARTIFACT_DELIVERY_REQUIRED",
      message: "先交付或保留子任务 Artifact；父 Session 的自主删除不能丢弃资源。" }], associatedSessionCount, artifacts);
    if (this.store.listSessionsByTask(taskId).some(session => sessionHasActiveRun(session)
      || this.store.getSessionRuntimeBlocker?.(session.id, { includeQueued: true }))) {
      return deletionPlan(item, null, [], [{ code: "SESSION_BUSY", message: "该任务的会话仍在执行或有未完成投递，请先停止后重试。" }], associatedSessionCount, artifacts);
    }
    if (this.store.selectOne?.("SELECT 1 FROM tasks WHERE parent_task_id=? AND COALESCE(deletion_status,'')<>'deleted' LIMIT 1", [taskId])) {
      return deletionPlan(item, null, [], [{code:"TASK_HAS_CHILDREN",message:"该任务仍有子任务。请先逐个处理子任务；删除不会自动级联。"}], associatedSessionCount, artifacts);
    }
    const owningIntegrationJob = this.store.getActiveWorktreeIntegrationJobForConflictTask?.(taskId) ?? null;
    if (owningIntegrationJob) {
      return deletionPlan(item, null, [], [{
        code: "ACTIVE_WORKTREE_INTEGRATION_JOB",
        message: "该冲突任务及其 Integration Worktree 正被未完成的一键合并占用。请先完成或取消该合并任务。"
      }], associatedSessionCount, artifacts);
    }
    const currentOperation = operationId && this.store.getTaskDeletionOperation(operationId);
    const previousRow = !operationId && this.store.selectOne?.(
      "SELECT operation_id FROM task_deletion_operations WHERE task_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1", [taskId]);
    const previous = previousRow && this.store.getTaskDeletionOperation(previousRow.operation_id);
    const pending = currentOperation?.result?.cleanup ?? currentOperation?.input?.resumeCleanup ?? previous?.result?.cleanup;
    if (!item.deletion_worktree_removed_at && pending?.worktreeRemoved) {
      const target = (currentOperation ?? previous).input.target;
      return deletionPlan(item, { status: "available", repositoryId: target.repositoryId, pendingCleanup: pending,
        worktree: { worktreeId: target.worktreeId, path: target.path, branchName: target.branchName,
          headOid: target.headOid, dirty: false, mergedIntoMain: true, sessions: [] } }, [], [], associatedSessionCount, artifacts);
    }
    if (item.deletion_worktree_removed_at) {
      return deletionPlan(item, { status: "removed", worktree: null }, [], [], associatedSessionCount, artifacts);
    }
    const activeStart = this.store.selectOne(
      `SELECT startup_operation_id FROM work_session_startup_operations WHERE task_id=?
       AND state IN ('allocated','worktree_prepared','session_bound','provider_bound','compensating') LIMIT 1`,
      [taskId]
    );
    if (activeStart) {
      return deletionPlan(item, null, [], [{ code: "START_IN_PROGRESS", message: "Task 正在启动。请等待启动完成或先安全取消启动。" }], associatedSessionCount, artifacts);
    }
    const inspection = await this.inspectWorktree(taskId);
    const risks = contentRisks(inspection?.worktree);
    const blockers = hardBlockers(inspection);
    return deletionPlan(item, inspection, risks, blockers, associatedSessionCount, artifacts);
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
    const plan = await this.inspect(taskId, actor, operationId);
    this.#assertDeletionAllowed(plan, input);
    if (input.target) {
      const actual = this.#target(taskId, plan), expected = input.target;
      const removed = Boolean(this.store.getTask(taskId).deletion_worktree_removed_at)
        || Boolean(plan.inspection?.pendingCleanup?.worktreeRemoved);
      const fields = ["taskId", "parentTaskId", "bindingRevision", ...(removed ? [] : ["repositoryId", "worktreeId", "path", "branchName", "headOid", "statusSummary"])];
      if (fields.some(key => actual[key] !== expected[key])
        || actual.sessionIds.some(id => !expected.sessionIds.includes(id))
        || actual.artifactIds.some(id => !expected.artifactIds.includes(id))) {
        throw coded("TASK_DELETE_TARGET_CHANGED", "删除目标或关联资源已变化，请重新检查并确认。", 409);
      }
    }
    const deleteWorktree = input.deleteWorktree !== false;
    const artifactDisposition = input.artifactDisposition ?? "delete";

    this.store.markTaskDeletion(taskId, "deleting", null);
    let cleanup = null;
    const deletedSessionIds = [];
    try {
      if (deleteWorktree && (plan.worktree || (operationId && input.target?.worktreeId
        && !this.store.getTask(taskId).deletion_worktree_removed_at))) {
        cleanup = await this.removeWorktree({ taskId, inspection: plan.inspection,
          force: input.mode === "force",
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
      const artifactCleanup = await this.handleArtifacts({
        task: this.store.getTask(taskId),
        artifacts: plan.artifacts,
        disposition: artifactDisposition,
        actor
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

  #assertDeletionAllowed(plan, input) {
    const deleteWorktree = input.deleteWorktree !== false;
    const artifactDisposition = input.artifactDisposition ?? "delete";
    if (!ARTIFACT_DISPOSITIONS.has(artifactDisposition)) {
      throw coded("TASK_ARTIFACT_DISPOSITION_INVALID", `Unsupported Artifact disposition: ${artifactDisposition}`, 400);
    }
    const effectiveBlockers = deleteWorktree
      ? plan.blockers
      : plan.blockers.filter((blocker) => !WORKTREE_ONLY_BLOCKERS.has(blocker.code));
    if (effectiveBlockers.length > 0) {
      throw coded("TASK_DELETE_BLOCKED", effectiveBlockers[0].message, 409, { deletion: plan });
    }
    const force = input.mode === "force";
    if (deleteWorktree && plan.risks.length > 0 && !force) {
      throw coded(
        "TASK_DELETE_RISK_CONFIRMATION_REQUIRED",
        "Task 的专属 Worktree 含有可能丢失的内容。请先合并，或经过二次确认后强制删除。",
        409,
        { deletion: plan }
      );
    }
    if (deleteWorktree && force && plan.worktree) this.#assertForceConfirmation(plan, input);
  }

  #assertForceConfirmation(plan, input) {
    if (plan.risks.some((risk) => !FORCEABLE_RISKS.has(risk.code))) {
      throw coded("TASK_DELETE_BLOCKED", "此风险不能通过强制确认绕过。", 409, { deletion: plan });
    }
    const branch = plan.worktree?.branchName ?? "";
    if (input.acknowledgeDataLoss !== true || !branch) {
      throw coded(
        "TASK_FORCE_DELETE_CONFIRMATION_REQUIRED",
        "强制删除会永久丢弃未提交文件和未合并提交。请确认数据丢失风险。",
        409,
        { deletion: plan }
      );
    }
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
