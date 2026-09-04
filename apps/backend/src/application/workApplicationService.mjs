// 实体层应用服务：Work / Task / 依赖 DAG（15 Phase 1，净新增）
//
// 职责：封装业务规则（字段校验、Work 存在性、依赖环检测），
// 数据访问全部委托给 store（corptieStore.mjs 的 CRUD 方法）。

import {
  validateWorkInput,
  validateTaskInput
} from "../domain/workTaskValidation.mjs";
import {
  buildAcceptanceAssessment,
  completionSuggestionForTask,
  parseAcceptanceAssessment,
  TaskAcceptanceError
} from "./taskAcceptance.mjs";

export class WorkNotFoundError extends Error {
  constructor(workId) {
    super(`Work not found: ${workId}`);
    this.name = "WorkNotFoundError";
    this.code = "WORK_NOT_FOUND";
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.code = "TASK_NOT_FOUND";
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
    this.code = "SESSION_NOT_FOUND";
  }
}

export class EntityCreationConflictError extends Error {
  constructor(entityType, id) {
    super(`${entityType} creation ID is already bound to different input: ${id}`);
    this.name = "EntityCreationConflictError";
    this.code = "ENTITY_CREATION_CONFLICT";
    this.statusCode = 409;
  }
}

export class DependencyCycleError extends Error {
  constructor(taskId, targetTaskId) {
    super(
      `Dependency would create a cycle: ${taskId} -> ${targetTaskId}`
    );
    this.name = "DependencyCycleError";
    this.code = "CYCLE_DETECTED";
  }
}

export class WorkApplicationService {
  constructor({ store, onEntityChanged = null }) {
    this.store = store;
    this.onEntityChanged = onEntityChanged;
  }

  emit(type, entity, action) {
    this.onEntityChanged?.(type, { action, entity });
    return entity;
  }

  // ---- Work ----

  createWork(input = {}) {
    const normalized = validateWorkInput(input, "create");
    if (normalized.id) {
      const existing = this.store.getWork(normalized.id);
      if (existing) {
        if (!workCreationMatches(existing, normalized)) {
          throw new EntityCreationConflictError("Work", normalized.id);
        }
        return existing;
      }
    }
    const work = this.store.runInTransaction(() => this.store.createWork(normalized));
    return this.emit("WorkChanged", work, "created");
  }

  listWorks() {
    return this.store.listWorks();
  }

  getWork(id) {
    const work = this.store.getWork(id);
    if (!work) throw new WorkNotFoundError(id);
    return work;
  }

  updateWork(id, patch = {}) {
    this.getWork(id);
    const normalized = validateWorkInput(patch, "update");
    const updated = this.store.runInTransaction(() => this.store.updateWork(id, normalized));
    return this.emit("WorkChanged", updated, "updated");
  }

  deleteWork(id) {
    this.getWork(id);
    const deleted = this.store.deleteWork(id);
    this.emit("WorkChanged", { id }, "deleted");
    return deleted;
  }

  // ---- Task ----

  createTask(input = {}, options = {}) {
    const normalized = validateTaskInput(input, "create");
    if (normalized.id) {
      const existing = this.store.getTask(normalized.id);
      if (existing) {
        if (!taskCreationMatches(existing, normalized)) {
          throw new EntityCreationConflictError("Task", normalized.id);
        }
        return existing;
      }
    }
    return this.emit(
      "TaskChanged",
      this.store.createTask(normalized, options.creationOrigin ?? {}),
      "created"
    );
  }

  listTasks() {
    return this.store.listTasks();
  }

  listTasksByWork(workId) {
    return this.store.listTasksByWork(workId);
  }

  getTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  updateTask(id, patch = {}) {
    const current = this.getTask(id);
    if (Object.prototype.hasOwnProperty.call(patch, "acceptanceAssessment")
      || Object.prototype.hasOwnProperty.call(patch, "executionStatus")) {
      throw new TaskAcceptanceError(
        "TASK_STATE_READ_ONLY",
        "acceptanceAssessment and executionStatus are managed by their dedicated workflows."
      );
    }
    const normalized = validateTaskInput(patch, "update");
    const nextPatch = { ...normalized };
    if (Object.prototype.hasOwnProperty.call(normalized, "acceptanceCriteria")
      && String(normalized.acceptanceCriteria ?? "").trim() !== String(current.acceptance_criteria ?? "").trim()) {
      nextPatch.acceptanceAssessment = null;
    }
    return this.emit("TaskChanged", this.store.updateTask(id, nextPatch), "updated");
  }

  reviseTask(id, input = {}) {
    this.getTask(id);
    const result = this.store.reviseTask(id, input);
    this.emit("TaskChanged", result.task, "revised");
    return result;
  }

  listTaskSnapshots(id) {
    this.getTask(id);
    return this.store.listTaskSnapshots(id);
  }

  rejectTaskAcceptance(id, input = {}) {
    const current = this.getTask(id);
    if (input.rejected !== true) {
      throw new TaskAcceptanceError(
        "USER_REJECTION_REQUIRED",
        "Rejecting an automated acceptance result requires explicit user confirmation."
      );
    }
    const currentAssessment = parseAcceptanceAssessment(current.acceptance_assessment_json);
    // A retry after the first rejection committed is the same successful
    // command. Keep its original audit timestamp and authoritative state.
    if (currentAssessment?.status === "rejected") return current;
    const suggestion = completionSuggestionForTask(current);
    if (!suggestion) {
      throw new TaskAcceptanceError(
        "ACCEPTANCE_NOT_PASSED",
        "This Task does not have a current passing automated acceptance result."
      );
    }
    const assessment = {
      ...suggestion,
      status: "rejected",
      rejectedAt: new Date().toISOString()
    };
    delete assessment.recommended;
    return this.emit(
      "TaskChanged",
      this.store.updateTask(id, {
        acceptanceAssessment: assessment,
        lifecycleState: current.lifecycle_state
      }),
      "acceptance-rejected-by-user"
    );
  }

  recordAcceptanceAssessment(id, input = {}) {
    const task = this.getTask(id);
    const sourceSessionId = String(input.sourceSessionId ?? "").trim();
    const session = sourceSessionId ? this.store.getSession(sourceSessionId) : null;
    if (!session) throw new SessionNotFoundError(sourceSessionId);
    if (session.taskId !== id) {
      throw new TaskAcceptanceError(
        "ACCEPTANCE_SOURCE_MISMATCH",
        "The acceptance source Session is not bound to this Task."
      );
    }

    const assessment = buildAcceptanceAssessment(task, input);
    const patch = {
      acceptanceAssessment: assessment,
      lifecycleState: task.lifecycle_state
    };
    return this.emit(
      "TaskChanged",
      this.store.updateTask(id, patch),
      assessment.status === "passed" ? "acceptance-passed" : "acceptance-not-proven"
    );
  }

  deleteTask(id) {
    this.getTask(id);
    const deleted = this.store.deleteTask(id);
    this.emit("TaskChanged", { id }, "deleted");
    return deleted;
  }

  // ---- Session 归属（打通 Work → Task → Session 最后一环）----

  // 把一个已存在的 Session 归属到某个 Task，自动带上其 Work。
  // 返回更新后的 Session（含 workId / taskId）。
  bindSession(sessionId, taskId) {
    const task = this.getTask(taskId);
    const existingSession = this.store.getSession(sessionId);
    if (!existingSession) throw new SessionNotFoundError(sessionId);
    const session = this.store.bindSessionToTask(sessionId, taskId, task.work_id);
    this.emit("TaskChanged", this.store.getTask(taskId), "session-bound");
    return session;
  }

  // 列出某 Task 名下所有 Session（按创建时间升序）。
  listSessionsByTask(taskId) {
    return this.store.listSessionsByTask(taskId);
  }

  // ---- 依赖编排 + 环检测 ----

  addDependency(taskId, targetTaskId, type = "depends_on") {
    this.getTask(taskId);
    this.getTask(targetTaskId);
    if (taskId === targetTaskId) {
      throw new DependencyCycleError(taskId, targetTaskId);
    }
    if (this.wouldCreateCycle(taskId, targetTaskId)) {
      throw new DependencyCycleError(taskId, targetTaskId);
    }
    return this.emit(
      "TaskChanged",
      this.store.addTaskDependency(taskId, targetTaskId, type),
      "dependency-added"
    );
  }

  removeDependency(taskId, targetTaskId) {
    const removed = this.store.removeTaskDependency(taskId, targetTaskId);
    this.emit("TaskChanged", { id: taskId, targetTaskId }, "dependency-removed");
    return removed;
  }

  listDependencies(taskId) {
    return this.store.listTaskDependencies(taskId);
  }

  listDependents(targetTaskId) {
    return this.store.listTaskDependents(targetTaskId);
  }

  // 从 target 出发，沿「依赖」边 DFS，看能否到达 from；能则加 from→target 会成环。
  wouldCreateCycle(fromId, targetId) {
    const visited = new Set();
    const stack = [targetId];
    while (stack.length) {
      const current = stack.pop();
      if (current === fromId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dep of this.store.listTaskDependencies(current)) {
        stack.push(dep.target_task_id);
      }
    }
    return false;
  }
}

function workCreationMatches(existing, input) {
  const expected = {
    name: input.name,
    description: input.description ?? "",
    status: input.status ?? "active",
    profile: input.profile ?? "general",
    tags: sortedStrings(input.tags ?? []),
    workspaceId: input.workspaceId ?? existing.workspaceId,
    contributorAgentIds: sortedStrings(input.contributorAgentIds ?? []),
    primaryAgentId: input.primaryAgentId ?? input.contributorAgentIds?.[0] ?? null
  };
  const actual = {
    name: existing.name,
    description: existing.description ?? "",
    status: existing.status ?? "active",
    profile: existing.profile ?? "general",
    tags: sortedStrings(existing.tags ?? []),
    workspaceId: existing.workspaceId,
    contributorAgentIds: sortedStrings(existing.contributorAgentIds ?? []),
    primaryAgentId: existing.primaryAgentId ?? null
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function taskCreationMatches(existing, input) {
  const expected = {
    workId: input.workId,
    title: input.title,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    priority: input.priority ?? "medium",
    verificationCriteria: input.verificationCriteria ?? "",
    lifecycleState: input.lifecycleState ?? "todo",
    mainAgentId: input.mainAgentId ?? null
  };
  const actual = {
    workId: existing.work_id,
    title: existing.title,
    description: existing.description ?? "",
    acceptanceCriteria: existing.acceptance_criteria ?? "",
    priority: existing.priority ?? "medium",
    verificationCriteria: existing.verification_criteria ?? "",
    lifecycleState: existing.lifecycle_state ?? "todo",
    mainAgentId: existing.main_agent_id ?? null
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}
