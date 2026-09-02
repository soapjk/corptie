const COMPLETED_EXECUTION_STATES = new Set(["completed"]);
const COMPLETED_TASK_STATES = new Set(["done", "complete", "completed"]);

export class ProjectWorktreeIntegrationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ProjectWorktreeIntegrationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Project-level Git integration stays independent of any Agent Provider. The only
// Agent-facing operation is the explicit conflict-resolution Task callback.
export class ProjectWorktreeIntegrationService {
  constructor(options = {}) {
    this.store = options.store;
    this.inspectProject = options.inspectProject;
    this.mergeWorktree = options.mergeWorktree;
    this.createConflictWorkspace = options.createConflictWorkspace;
    this.createAndLaunchConflictTask = options.createAndLaunchConflictTask;
    this.isSessionActive = options.isSessionActive ?? (() => false);
    this.presentTask = options.presentTask ?? ((task) => task);
    this.onEvent = options.onEvent ?? (() => {});
    this.activeProjects = new Set();
    this.activeConflictRuns = new Set();
    for (const method of [
      "inspectProject",
      "mergeWorktree",
      "createConflictWorkspace",
      "createAndLaunchConflictTask"
    ]) {
      if (typeof this[method] !== "function") {
        throw new TypeError(`ProjectWorktreeIntegrationService requires ${method}().`);
      }
    }
  }

  async status(projectId, objectiveId) {
    const scope = await this.#scope(projectId, objectiveId);
    const inspection = await this.inspectProject(scope.projectId);
    const candidates = this.#candidates(scope, inspection);
    const latestRun = this.#reconcileResolvedRun(
      this.store.getLatestProjectIntegrationRun(scope.projectId, scope.objective.id),
      inspection
    );
    return this.#present(scope, inspection, candidates, latestRun);
  }

  async integrateCompleted(projectId, objectiveId) {
    const key = String(projectId);
    if (this.activeProjects.has(key)) {
      throw new ProjectWorktreeIntegrationError(
        "INTEGRATION_ALREADY_RUNNING",
        "A Worktree integration is already running for this project.",
        409
      );
    }
    this.activeProjects.add(key);
    try {
      const scope = await this.#scope(projectId, objectiveId);
      const initial = await this.inspectProject(scope.projectId, { forceFresh: true, reason: "integration_execute_preflight" });
      const candidates = this.#candidates(scope, initial);
      const latest = this.#reconcileResolvedRun(
        this.store.getLatestProjectIntegrationRun(scope.projectId, scope.objective.id),
        initial
      );
      if (latest?.items.some((item) => item.status === "conflict")) {
        throw new ProjectWorktreeIntegrationError(
          "UNRESOLVED_INTEGRATION_CONFLICTS",
          "Resolve the conflicts from the latest Integration Run before starting another one.",
          409
        );
      }
      if (candidates.eligible.length === 0) {
        throw new ProjectWorktreeIntegrationError(
          "NO_COMPLETED_WORKTREES",
          "There are no completed Worktrees eligible for integration."
        );
      }
      const run = this.store.createProjectIntegrationRun({
        repositoryId: scope.projectId,
        objectiveId: scope.objective.id,
        mainHeadBefore: initial.mainHeadOid,
        items: candidates.eligible.map((candidate, ordinal) => ({
          worktreeId: candidate.worktreeId,
          taskId: candidate.taskId,
          branchName: candidate.branchName,
          sourceHeadOid: candidate.headOid,
          ordinal
        }))
      });
      this.onEvent("ProjectWorktreeIntegrationStarted", { run });

      for (const item of run.items) {
        this.store.updateProjectIntegrationItem(run.id, item.worktreeId, { status: "merging", error: null });
        try {
          const current = await this.inspectProject(scope.projectId, { forceFresh: true, reason: "integration_item_preflight" });
          const worktree = current.worktrees.find((entry) => entry.worktreeId === item.worktreeId);
          if (!worktree || worktree.availability !== "available") {
            throw new ProjectWorktreeIntegrationError(
              "WORKTREE_UNAVAILABLE",
              `Worktree ${item.branchName ?? item.worktreeId} is unavailable.`
            );
          }
          if (worktree.headOid !== item.sourceHeadOid) {
            throw new ProjectWorktreeIntegrationError(
              "SOURCE_HEAD_CHANGED",
              `Branch ${item.branchName ?? item.worktreeId} changed after integration started.`
            );
          }
          if (worktree.dirty) {
            throw new ProjectWorktreeIntegrationError(
              "WORKTREE_DIRTY",
              `Worktree ${item.branchName ?? item.worktreeId} has uncommitted changes.`
            );
          }
          if (worktree.mergedIntoMain) {
            this.store.updateProjectIntegrationItem(run.id, item.worktreeId, {
              status: "already_integrated",
              mergedMainHead: current.mainHeadOid,
              error: null
            });
            continue;
          }
          const result = await this.mergeWorktree({
            projectId: scope.projectId,
            mainPath: current.mainPath,
            worktreeId: item.worktreeId
          });
          this.store.updateProjectIntegrationItem(run.id, item.worktreeId, {
            status: "integrated",
            mergedMainHead: result.mainHead,
            error: null
          });
        } catch (error) {
          const conflictFiles = conflictFilesFromError(error);
          this.store.updateProjectIntegrationItem(run.id, item.worktreeId, {
            status: conflictFiles.length > 0 ? "conflict" : "failed",
            conflictFiles,
            error: error.message
          });
        }
      }

      const finalInspection = await this.inspectProject(scope.projectId, { forceFresh: true, reason: "integration_completed" });
      const completed = this.store.getProjectIntegrationRun(run.id);
      const hasConflicts = completed.items.some((item) => item.status === "conflict");
      const hasFailures = completed.items.some((item) => item.status === "failed");
      const status = hasConflicts
        ? "conflicts_detected"
        : (hasFailures ? "failed" : "integrated");
      const finalized = this.store.updateProjectIntegrationRun(run.id, {
        status,
        mainHeadAfter: finalInspection.mainHeadOid,
        completedAt: new Date().toISOString()
      });
      this.onEvent("ProjectWorktreeIntegrationCompleted", { run: finalized });
      const refreshedCandidates = this.#candidates(scope, finalInspection);
      return this.#present(scope, finalInspection, refreshedCandidates, finalized);
    } finally {
      this.activeProjects.delete(key);
    }
  }

  async createConflictTask(projectId, objectiveId, runId, input = {}) {
    const conflictRunKey = String(runId);
    if (this.activeConflictRuns.has(conflictRunKey)) {
      throw new ProjectWorktreeIntegrationError(
        "CONFLICT_TASK_ALREADY_CREATING",
        "The conflict-resolution Task is already being created.",
        409
      );
    }
    this.activeConflictRuns.add(conflictRunKey);
    try {
    const scope = await this.#scope(projectId, objectiveId);
    let run = this.store.getProjectIntegrationRun(runId);
    if (!run || run.repositoryId !== scope.projectId || run.objectiveId !== scope.objective.id) {
      throw new ProjectWorktreeIntegrationError("INTEGRATION_NOT_FOUND", "Integration Run not found.", 404);
    }
    const conflicts = run.items.filter((item) => item.status === "conflict");
    if (conflicts.length === 0) {
      throw new ProjectWorktreeIntegrationError(
        "NO_INTEGRATION_CONFLICTS",
        "This Integration Run has no merge conflicts."
      );
    }
    if (run.conflictTaskId) {
      const existingTask = this.store.getTask(run.conflictTaskId);
      if (existingTask) {
        const inspection = await this.inspectProject(scope.projectId);
        const presented = this.#present(scope, inspection, this.#candidates(scope, inspection), run);
        return {
          run: presented.latestRun,
          task: this.presentTask(existingTask),
          session: run.conflictSessionId ? this.store.getSession(run.conflictSessionId) : null,
          reused: true
        };
      }
      run = this.store.updateProjectIntegrationRun(run.id, {
        status: "conflicts_detected",
        conflictTaskId: null,
        conflictSessionId: null
      });
    }
    const agentId = String(input.agentId ?? "").trim();
    const agent = agentId ? this.store.getAgent(agentId) : null;
    if (!agent || agent.role !== "independentContributor") {
      throw new ProjectWorktreeIntegrationError(
        "INTEGRATION_AGENT_REQUIRED",
        "Select an Independent Contributor Agent to resolve the conflicts."
      );
    }
    if (!(scope.objective.contributorAgentIds ?? []).includes(agent.agentId)) {
      throw new ProjectWorktreeIntegrationError(
        "INTEGRATION_AGENT_OUT_OF_SCOPE",
        "The selected Agent is not a contributor to this Objective."
      );
    }

    const workspace = run.integrationWorktreeId
      ? {
          worktreeId: run.integrationWorktreeId,
          path: run.integrationWorktreePath,
          branchName: run.integrationBranch
        }
      : await this.createConflictWorkspace({
          projectId: scope.projectId,
          runId: run.id,
          mainHead: run.mainHeadAfter ?? run.mainHeadBefore
        });
    if (!run.integrationWorktreeId) {
      run = this.store.updateProjectIntegrationRun(run.id, {
        status: "conflict_resolution_preparing",
        integrationWorktreeId: workspace.worktreeId,
        integrationWorktreePath: workspace.path,
        integrationBranch: workspace.branchName
      });
    }
    const tasks = new Map(
      this.store.listTasksByObjective(scope.objective.id).map((item) => [item.id, item])
    );
    const sourceLines = conflicts.map((item) => {
      const task = tasks.get(item.taskId);
      const files = item.conflictFiles.length > 0 ? `；冲突文件：${item.conflictFiles.join(", ")}` : "";
      return `- ${item.branchName ?? item.worktreeId} — ${task?.title ?? item.taskId}${files}`;
    });
    const title = input.title?.trim() || `处理 ${conflicts.length} 个 Worktree 的集成冲突`;
    const description = [
      `处理 Integration Run ${run.id} 中遗留的 Worktree 合并冲突。`,
      "",
      `目标 main 基线：${workspace.headOid ?? run.mainHeadAfter ?? run.mainHeadBefore}`,
      `Integration 分支：${workspace.branchName}`,
      "",
      "来源分支：",
      ...sourceLines,
      "",
      "必须按列表顺序逐个合并并解决冲突；不得删除来源分支，不得推送远端。"
    ].join("\n");
    const acceptanceCriteria = [
      "- 所有指定来源分支的有效修改均已进入 Integration 分支",
      "- 所有 Git 冲突均已按双方语义解决，且不存在冲突标记或未合并文件",
      "- 相关测试通过",
      "- Development APP 与后端能够成功启动并通过健康检查",
      "- Integration 分支已安全合入最新 main",
      "- 所有来源分支均成为 main 的祖先",
      "- 未执行远程推送，未删除来源 Worktree"
    ].join("\n");
    const prompt = [
      description,
      "",
      "固定执行流程：",
      "1. 确认当前工作目录是系统创建的 Integration Worktree。",
      "2. 按来源分支顺序逐个执行本地合并，分析并解决双方语义冲突。不得简单全选 ours 或 theirs。",
      "3. 每完成一个来源分支就创建一次清晰的本地提交。",
      "4. 完成全部分支后运行相关测试，并执行项目规定的 Development 重建、启动和健康检查。",
      "5. 最后将 Integration 分支合入本地 main，并验证每个来源分支都是 main 的祖先。",
      "6. 不得推送远端，不得删除任何来源 Worktree 或分支。"
    ].join("\n");
    const created = await this.createAndLaunchConflictTask({
      objective: scope.objective,
      projectId: scope.projectId,
      agent,
      workspace,
      title,
      description,
      acceptanceCriteria,
      prompt,
      integrationRunId: run.id,
      sourceSessionId: this.#sourceSessionId(run)
    });
    const updatedRun = this.store.updateProjectIntegrationRun(run.id, {
      status: "conflict_resolution_running",
      integrationWorktreeId: workspace.worktreeId,
      integrationWorktreePath: workspace.path,
      integrationBranch: workspace.branchName,
      conflictTaskId: created.task.id,
      conflictSessionId: created.session.id
    });
    this.onEvent("ProjectWorktreeConflictResolutionStarted", {
      run: updatedRun,
      task: created.task,
      session: created.session
    });
    const inspection = await this.inspectProject(scope.projectId);
    const presented = this.#present(scope, inspection, this.#candidates(scope, inspection), updatedRun);
    return { run: presented.latestRun, ...created, reused: false };
    } finally {
      this.activeConflictRuns.delete(conflictRunKey);
    }
  }

  #sourceSessionId(run) {
    for (const item of run.items ?? []) {
      const task = item.taskId ? this.store.getTask(item.taskId) : null;
      const logical = task?.current_session_id
        ? this.store.getLogicalSessionByLegacySessionId(task.current_session_id)
        : null;
      if (logical?.logicalSessionId && !logical.archived && logical.activeBinding?.state === "active") {
        return logical.logicalSessionId;
      }
    }
    throw new ProjectWorktreeIntegrationError(
      "SOURCE_SESSION_NOT_FOUND",
      "Conflict resolution requires an active source Work Session from the Integration Run.",
      409
    );
  }

  async #scope(projectId, objectiveId) {
    const project = String(projectId ?? "").trim();
    const objective = this.store.getObjective(String(objectiveId ?? "").trim());
    if (!objective) {
      throw new ProjectWorktreeIntegrationError("OBJECTIVE_NOT_FOUND", "Objective not found.", 404);
    }
    if (!project || !(objective.workspaceIds ?? []).includes(project)) {
      throw new ProjectWorktreeIntegrationError(
        "OBJECTIVE_PROJECT_MISMATCH",
        "This Project is not attached to the selected Objective."
      );
    }
    return { projectId: project, objective };
  }

  #candidates(scope, inspection) {
    const tasks = this.store.listTasksByObjective(scope.objective.id);
    const tasksById = new Map(tasks.map((item) => [item.id, item]));
    const tasksBySessionId = new Map(
      tasks.filter((item) => item.current_session_id).map((item) => [item.current_session_id, item])
    );
    const eligible = [];
    const excluded = [];
    for (const worktree of inspection.worktrees ?? []) {
      if (worktree.isMain) continue;
      const sessions = (worktree.sessions ?? [])
        .map((binding) => binding.sessionId ? this.store.getSession(binding.sessionId) : null)
        .filter(Boolean);
      const task = sessions.map((session) => (
        tasksById.get(session.taskId) ?? tasksBySessionId.get(session.id)
      )).find(Boolean);
      const candidate = {
        worktreeId: worktree.worktreeId,
        path: worktree.path,
        branchName: worktree.branchName,
        headOid: worktree.headOid,
        taskId: task?.id ?? null,
        taskTitle: task?.title ?? null
      };
      let reason = null;
      if (!task) reason = "not_bound_to_objective_task";
      else if (worktree.availability !== "available") reason = "worktree_unavailable";
      else if (worktree.dirty) reason = "worktree_dirty";
      else if (worktree.mergedIntoMain) reason = "already_integrated";
      else if (!worktree.branchName || !worktree.headOid) reason = "branch_unavailable";
      else if (sessions.some((session) => this.isSessionActive(session))) reason = "session_active";
      else if (!COMPLETED_EXECUTION_STATES.has(task.execution_status)
        && !COMPLETED_TASK_STATES.has(task.lifecycle_state)) reason = "task_not_completed";
      (reason ? excluded : eligible).push(reason ? { ...candidate, reason } : candidate);
    }
    eligible.sort((left, right) => {
      const leftItem = tasksById.get(left.taskId);
      const rightItem = tasksById.get(right.taskId);
      return String(leftItem?.updated_at ?? "").localeCompare(String(rightItem?.updated_at ?? ""));
    });
    return { eligible, excluded };
  }

  #present(scope, inspection, candidates, run) {
    const tasks = new Map(
      this.store.listTasksByObjective(scope.objective.id).map((item) => [item.id, item])
    );
    const agents = (scope.objective.contributorAgentIds ?? [])
      .map((agentId) => this.store.getAgent(agentId))
      .filter((agent) => agent?.role === "independentContributor")
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        role: agent.role
      }));
    const presentedRun = presentProjectIntegrationRun(run, {
      resolveTask: (taskId) => tasks.get(taskId)
    });
    return {
      projectId: scope.projectId,
      objective: { id: scope.objective.id, name: scope.objective.name },
      mainHeadOid: inspection.mainHeadOid,
      eligibleWorktrees: candidates.eligible,
      excludedWorktrees: candidates.excluded,
      eligibleAgents: agents,
      latestRun: presentedRun
    };
  }

  #reconcileResolvedRun(run, inspection) {
    if (!run || !["conflict_resolution_preparing", "conflict_resolution_running"].includes(run.status)) {
      return run;
    }
    const conflictItems = run.items.filter((item) => item.status === "conflict");
    if (conflictItems.length === 0) return run;
    const worktrees = new Map((inspection.worktrees ?? []).map((worktree) => [worktree.worktreeId, worktree]));
    if (!conflictItems.every((item) => worktrees.get(item.worktreeId)?.mergedIntoMain === true)) {
      return run;
    }
    for (const item of conflictItems) {
      this.store.updateProjectIntegrationItem(run.id, item.worktreeId, {
        status: "integrated",
        mergedMainHead: inspection.mainHeadOid,
        conflictFiles: [],
        error: null
      });
    }
    const reconciled = this.store.updateProjectIntegrationRun(run.id, {
      status: "integrated",
      mainHeadAfter: inspection.mainHeadOid,
      completedAt: new Date().toISOString(),
      error: null
    });
    this.onEvent("ProjectWorktreeConflictResolutionCompleted", { run: reconciled });
    return reconciled;
  }
}

export function conflictFilesFromError(error) {
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
  const files = new Set();
  for (const line of text.split(/\r?\n/)) {
    const conflict = line.match(/CONFLICT \([^)]*\): .*? in (.+)$/);
    if (conflict?.[1]) files.add(conflict[1].trim());
  }
  return [...files];
}

export function integrationCounts(items = []) {
  const count = (states) => items.filter((item) => states.includes(item.status)).length;
  return {
    total: items.length,
    integrated: count(["integrated", "already_integrated"]),
    conflicts: count(["conflict"]),
    failed: count(["failed"]),
    pending: count(["pending", "merging"])
  };
}

// One provider-neutral wire contract is shared by the project integration API
// and the revisioned control-plane snapshot. Store rows deliberately omit
// derived labels/counts, so they must never be exposed directly to clients.
export function presentProjectIntegrationRun(run, options = {}) {
  if (!run) return null;
  const resolveTask = options.resolveTask ?? (() => null);
  const items = (run.items ?? []).map((item) => ({
    ...item,
    taskTitle: resolveTask(item.taskId)?.title
      ?? item.taskTitle
      ?? item.taskId
  }));
  return {
    ...run,
    items,
    counts: integrationCounts(items)
  };
}
