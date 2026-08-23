const FORCEABLE_RISKS = new Set(["UNCOMMITTED_CHANGES", "UNTRACKED_FILES", "NOT_MERGED_INTO_MAIN"]);

export class WorkItemDeletionService {
  constructor(options = {}) {
    this.store = options.store;
    this.inspectWorktree = options.inspectWorktree;
    this.removeWorktree = options.removeWorktree;
    this.onChanged = options.onChanged ?? (() => {});
    if (!this.store || typeof this.store.finalizeWorkItemDeletion !== "function") {
      throw new TypeError("WorkItemDeletionService requires a Store with deletion support.");
    }
    for (const method of ["inspectWorktree", "removeWorktree"]) {
      if (typeof this[method] !== "function") throw new TypeError(`WorkItemDeletionService requires ${method}().`);
    }
  }

  async inspect(workItemId) {
    const item = this.store.getWorkItem(workItemId);
    if (!item) throw coded("WORK_ITEM_NOT_FOUND", `WorkItem not found: ${workItemId}`, 404);
    if (item.deletion_worktree_removed_at) {
      return deletionPlan(item, { status: "removed", worktree: null }, [], []);
    }
    const activeStart = this.store.selectOne(
      "SELECT operation_id FROM work_item_start_operations WHERE work_item_id=? AND status='in_progress' LIMIT 1",
      [workItemId]
    );
    if (activeStart) {
      return deletionPlan(item, null, [], [{ code: "START_IN_PROGRESS", message: "WorkItem 正在启动。请等待启动完成或先安全取消启动。" }]);
    }
    const inspection = await this.inspectWorktree(workItemId);
    const risks = contentRisks(inspection?.worktree);
    const blockers = hardBlockers(inspection);
    return deletionPlan(item, inspection, risks, blockers);
  }

  async delete(workItemId, input = {}) {
    const plan = await this.inspect(workItemId);
    if (plan.blockers.length > 0) {
      throw coded("WORK_ITEM_DELETE_BLOCKED", plan.blockers[0].message, 409, { deletion: plan });
    }
    const force = input.mode === "force";
    if (plan.risks.length > 0 && !force) {
      throw coded(
        "WORK_ITEM_DELETE_RISK_CONFIRMATION_REQUIRED",
        "WorkItem 的专属 Worktree 含有可能丢失的内容。请先合并，或经过二次确认后强制删除。",
        409,
        { deletion: plan }
      );
    }
    if (force) this.#assertForceConfirmation(plan, input);

    this.store.markWorkItemDeletion(workItemId, "deleting", null);
    let cleanup = null;
    try {
      if (plan.worktree) {
        cleanup = await this.removeWorktree({
          workItemId,
          inspection: plan.inspection,
          force,
          confirmedBranchName: input.confirmedBranchName
        });
        this.store.markWorkItemWorktreeRemoved(workItemId);
      }
      const resources = this.store.finalizeWorkItemDeletion(workItemId);
      this.onChanged("WorkItemChanged", { action: "deleted", entity: { id: workItemId } });
      return { ok: true, workItemId, cleanup, resources };
    } catch (error) {
      if (this.store.getWorkItem(workItemId)) {
        this.store.markWorkItemDeletion(workItemId, "delete_failed", actionableFailure(error));
      }
      throw coded(
        error?.code ?? "WORK_ITEM_DELETE_FAILED",
        `删除未完成，已保留可识别状态，可安全重试：${actionableFailure(error)}`,
        error?.statusCode ?? 409
      );
    }
  }

  #assertForceConfirmation(plan, input) {
    if (plan.risks.some((risk) => !FORCEABLE_RISKS.has(risk.code))) {
      throw coded("WORK_ITEM_DELETE_BLOCKED", "此风险不能通过强制确认绕过。", 409, { deletion: plan });
    }
    const branch = plan.worktree?.branchName ?? "";
    if (input.acknowledgeDataLoss !== true || !branch || input.confirmedBranchName !== branch) {
      throw coded(
        "WORK_ITEM_FORCE_DELETE_CONFIRMATION_REQUIRED",
        `强制删除会永久丢弃未提交文件和未合并提交。请输入完整分支名 ${branch} 并确认数据丢失风险。`,
        409,
        { deletion: plan }
      );
    }
  }
}

function deletionPlan(item, inspection, risks, blockers) {
  return {
    workItemId: item.id,
    status: blockers.length > 0 ? "blocked" : (risks.length > 0 ? "risky" : "safe"),
    retryable: true,
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
  if (!code || FORCEABLE_RISKS.has(code) || code === "INTEGRATION_PENDING" || code === "WORK_ITEM_NOT_COMPLETED") return [];
  const messages = {
    MAIN_WORKTREE: "关联目录是目标主 Worktree，禁止删除共享主目录或主分支。",
    SESSION_BUSY: "关联 Session 仍在运行。请先等待或终止执行。",
    SHARED_WITH_ACTIVE_WORK_ITEM: "该 Worktree 仍被其他 WorkItem 使用，禁止删除共享资源。",
    WORKTREE_UNAVAILABLE: "关联 Worktree 当前不可访问。请恢复磁盘或修复 Git Worktree 后重试。",
    NO_WORKSPACE_ROUTE: "WorkItem 的 Workspace 路由已失效，无法确认专属资源边界。"
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
