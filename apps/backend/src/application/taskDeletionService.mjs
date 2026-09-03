const FORCEABLE_RISKS = new Set(["UNCOMMITTED_CHANGES", "UNTRACKED_FILES", "NOT_MERGED_INTO_MAIN"]);
const ARTIFACT_DISPOSITIONS = new Set(["delete", "objective", "retain"]);

export class TaskDeletionService {
  constructor(options = {}) {
    this.store = options.store;
    this.inspectWorktree = options.inspectWorktree;
    this.removeWorktree = options.removeWorktree;
    this.deleteSession = options.deleteSession;
    this.handleArtifacts = options.handleArtifacts;
    this.authorize = options.authorize;
    this.onChanged = options.onChanged ?? (() => {});
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

  async inspect(taskId, actor = null) {
    const item = this.store.getTask(taskId);
    if (!item) throw coded("TASK_NOT_FOUND", `Task not found: ${taskId}`, 404);
    if (await this.authorize({ actor, task: item, operation: "delete" }) !== true) {
      throw coded("TASK_DELETE_FORBIDDEN", "You do not have permission to delete this Task.", 403);
    }
    const associations = this.store.listTaskDeletionBlockingAssociations(taskId);
    const artifacts = Array.isArray(associations?.artifacts) ? associations.artifacts : [];
    const associatedSessionCount = this.store.listSessionsByTask(taskId).length;
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

  async delete(taskId, input = {}, actor = null) {
    const plan = await this.inspect(taskId, actor);
    const deleteWorktree = input.deleteWorktree !== false;
    const artifactDisposition = input.artifactDisposition ?? "delete";
    if (!ARTIFACT_DISPOSITIONS.has(artifactDisposition)) {
      throw coded("TASK_ARTIFACT_DISPOSITION_INVALID", `Unsupported Artifact disposition: ${artifactDisposition}`, 400);
    }
    const effectiveBlockers = deleteWorktree
      ? plan.blockers
      : plan.blockers.filter((blocker) => blocker.code === "START_IN_PROGRESS");
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
    if (deleteWorktree && force) this.#assertForceConfirmation(plan, input);

    this.store.markTaskDeletion(taskId, "deleting", null);
    let cleanup = null;
    const deletedSessionIds = [];
    try {
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
      if (deleteWorktree && plan.worktree) {
        cleanup = await this.removeWorktree({
          taskId,
          inspection: plan.inspection,
          force,
          confirmedBranchName: input.confirmedBranchName
        });
        this.store.markTaskWorktreeRemoved(taskId);
      }
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

  #assertForceConfirmation(plan, input) {
    if (plan.risks.some((risk) => !FORCEABLE_RISKS.has(risk.code))) {
      throw coded("TASK_DELETE_BLOCKED", "此风险不能通过强制确认绕过。", 409, { deletion: plan });
    }
    const branch = plan.worktree?.branchName ?? "";
    if (input.acknowledgeDataLoss !== true || !branch || input.confirmedBranchName !== branch) {
      throw coded(
        "TASK_FORCE_DELETE_CONFIRMATION_REQUIRED",
        `强制删除会永久丢弃未提交文件和未合并提交。请输入完整分支名 ${branch} 并确认数据丢失风险。`,
        409,
        { deletion: plan }
      );
    }
  }
}

function deletionPlan(item, inspection, risks, blockers, associatedSessionCount, artifacts = []) {
  return {
    taskId: item.id,
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
  if (worktree.mergedIntoMain !== true) risks.push({
    code: "NOT_MERGED_INTO_MAIN",
    message: `Worktree 有 ${Number(worktree.aheadOfMain) || 0} 个提交尚未合并到目标主分支。`,
    commitCount: Number(worktree.aheadOfMain) || 0
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
    NO_WORKSPACE_ROUTE: "Task 的 Workspace 路由已失效，无法确认专属资源边界。"
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
