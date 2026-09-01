// 实体层应用服务：Objective / Task / 依赖 DAG（15 Phase 1，净新增）
//
// 职责：封装业务规则（字段校验、Objective 存在性、依赖环检测），
// 数据访问全部委托给 store（corptieStore.mjs 的 CRUD 方法）。

import {
  validateObjectiveInput,
  validateTaskInput
} from "../domain/objectiveTaskValidation.mjs";
import {
  buildAcceptanceAssessment,
  completionSuggestionForTask,
  parseAcceptanceAssessment,
  TaskAcceptanceError
} from "./taskAcceptance.mjs";

export class ObjectiveNotFoundError extends Error {
  constructor(objectiveId) {
    super(`Objective not found: ${objectiveId}`);
    this.name = "ObjectiveNotFoundError";
    this.code = "OBJECTIVE_NOT_FOUND";
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

export class ObjectiveApplicationService {
  constructor({ store, onEntityChanged = null }) {
    this.store = store;
    this.onEntityChanged = onEntityChanged;
  }

  emit(type, entity, action) {
    this.onEntityChanged?.(type, { action, entity });
    return entity;
  }

  // ---- Objective ----

  createObjective(input = {}) {
    const normalized = validateObjectiveInput(input, "create");
    if (normalized.id) {
      const existing = this.store.getObjective(normalized.id);
      if (existing) {
        if (!objectiveCreationMatches(existing, normalized)) {
          throw new EntityCreationConflictError("Objective", normalized.id);
        }
        return existing;
      }
    }
    const objective = this.store.runInTransaction(() => {
      const created = this.store.createObjective(normalized);
      for (const targetId of normalized.relatedObjectiveIds ?? []) {
        this.addReverseRelation(created.id, targetId);
      }
      return created;
    });
    return this.emit("ObjectiveChanged", objective, "created");
  }

  listObjectives() {
    return this.store.listObjectives();
  }

  getObjective(id) {
    const objective = this.store.getObjective(id);
    if (!objective) throw new ObjectiveNotFoundError(id);
    return objective;
  }

  updateObjective(id, patch = {}) {
    const current = this.getObjective(id);
    const normalized = validateObjectiveInput(patch, "update");
    // relatedObjectiveIds 为对称关联：A 关联 B ⟺ B 关联 A。diff 出新增/移除，同步对侧。
    const updated = this.store.runInTransaction(() => {
      const entity = this.store.updateObjective(id, normalized);
      if (Object.prototype.hasOwnProperty.call(normalized, "relatedObjectiveIds")) {
        const old = new Set(current.relatedObjectiveIds ?? []);
        const next = new Set(normalized.relatedObjectiveIds);
        for (const targetId of next) if (!old.has(targetId)) this.addReverseRelation(id, targetId);
        for (const targetId of old) if (!next.has(targetId)) this.removeReverseRelation(id, targetId);
      }
      return entity;
    });
    return this.emit("ObjectiveChanged", updated, "updated");
  }

  // 对称关联维护：调用前已经完成自身与资源存在性校验。
  addReverseRelation(fromId, targetId) {
    if (!targetId || targetId === fromId) return;
    const target = this.store.getObjective(targetId);
    if (!target) throw new ObjectiveNotFoundError(targetId);
    const ids = new Set(target.relatedObjectiveIds ?? []);
    if (ids.has(fromId)) return;
    ids.add(fromId);
    this.store.updateObjective(targetId, { relatedObjectiveIds: [...ids] });
  }

  removeReverseRelation(fromId, targetId) {
    if (!targetId) return;
    const target = this.store.getObjective(targetId);
    if (!target) return;
    const ids = new Set(target.relatedObjectiveIds ?? []);
    if (!ids.has(fromId)) return;
    ids.delete(fromId);
    this.store.updateObjective(targetId, { relatedObjectiveIds: [...ids] });
  }

  deleteObjective(id) {
    this.getObjective(id);
    const deleted = this.store.deleteObjective(id);
    this.emit("ObjectiveChanged", { id }, "deleted");
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

  listTasksByObjective(objectiveId) {
    return this.store.listTasksByObjective(objectiveId);
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

  // ---- Session 归属（打通 Objective → Task → Session 最后一环）----

  // 把一个已存在的 Session 归属到某个 Task，自动带上其 Objective。
  // 返回更新后的 Session（含 objectiveId / taskId）。
  bindSession(sessionId, taskId) {
    const task = this.getTask(taskId);
    const existingSession = this.store.getSession(sessionId);
    if (!existingSession) throw new SessionNotFoundError(sessionId);
    const session = this.store.bindSessionToTask(sessionId, taskId, task.objective_id);
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

function objectiveCreationMatches(existing, input) {
  const expected = {
    name: input.name,
    description: input.description ?? "",
    idealState: input.idealState ?? "",
    status: input.status ?? "active",
    budgetConfig: input.budgetConfig ?? {},
    priority: input.priority ?? null,
    targetDate: input.targetDate ?? null,
    tags: sortedStrings(input.tags ?? []),
    workspaceIds: sortedStrings(input.workspaceIds ?? []),
    relatedObjectiveIds: sortedStrings(input.relatedObjectiveIds ?? []),
    contributorAgentIds: sortedStrings(input.contributorAgentIds ?? [])
  };
  const actual = {
    name: existing.name,
    description: existing.description ?? "",
    idealState: existing.idealState ?? "",
    status: existing.status ?? "active",
    budgetConfig: existing.budgetConfig ?? {},
    priority: existing.priority ?? null,
    targetDate: existing.targetDate ?? null,
    tags: sortedStrings(existing.tags ?? []),
    workspaceIds: sortedStrings(existing.workspaceIds ?? []),
    relatedObjectiveIds: sortedStrings(existing.relatedObjectiveIds ?? []),
    contributorAgentIds: sortedStrings(existing.contributorAgentIds ?? [])
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function taskCreationMatches(existing, input) {
  const expected = {
    objectiveId: input.objectiveId,
    title: input.title,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    priority: input.priority ?? "medium",
    goal: input.goal ?? "",
    verificationCriteria: input.verificationCriteria ?? "",
    lifecycleState: input.lifecycleState ?? "todo",
    mainWorkspaceId: input.mainWorkspaceId ?? null,
    mainAgentId: input.mainAgentId ?? null
  };
  const actual = {
    objectiveId: existing.objective_id,
    title: existing.title,
    description: existing.description ?? "",
    acceptanceCriteria: existing.acceptance_criteria ?? "",
    priority: existing.priority ?? "medium",
    goal: existing.goal ?? "",
    verificationCriteria: existing.verification_criteria ?? "",
    lifecycleState: existing.lifecycle_state ?? "todo",
    mainWorkspaceId: existing.main_workspace_id ?? null,
    mainAgentId: existing.main_agent_id ?? null
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}
