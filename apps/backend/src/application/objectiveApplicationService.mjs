// 实体层应用服务：Objective / WorkItem / 依赖 DAG（15 Phase 1，净新增）
//
// 职责：封装业务规则（字段校验、Objective 存在性、依赖环检测），
// 数据访问全部委托给 store（corptieStore.mjs 的 CRUD 方法）。

import {
  validateObjectiveInput,
  validateWorkItemInput
} from "../domain/objectiveWorkItemValidation.mjs";
import {
  buildAcceptanceAssessment,
  completionSuggestionForWorkItem,
  WorkItemAcceptanceError
} from "./workItemAcceptance.mjs";

export class ObjectiveNotFoundError extends Error {
  constructor(objectiveId) {
    super(`Objective not found: ${objectiveId}`);
    this.name = "ObjectiveNotFoundError";
    this.code = "OBJECTIVE_NOT_FOUND";
  }
}

export class WorkItemNotFoundError extends Error {
  constructor(workItemId) {
    super(`WorkItem not found: ${workItemId}`);
    this.name = "WorkItemNotFoundError";
    this.code = "WORK_ITEM_NOT_FOUND";
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
    this.code = "SESSION_NOT_FOUND";
  }
}

export class DependencyCycleError extends Error {
  constructor(workItemId, targetWorkItemId) {
    super(
      `Dependency would create a cycle: ${workItemId} -> ${targetWorkItemId}`
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

  // ---- WorkItem ----

  createWorkItem(input = {}) {
    const normalized = validateWorkItemInput(input, "create");
    return this.emit("WorkItemChanged", this.store.createWorkItem(normalized), "created");
  }

  listWorkItems() {
    return this.store.listWorkItems();
  }

  listWorkItemsByObjective(objectiveId) {
    return this.store.listWorkItemsByObjective(objectiveId);
  }

  getWorkItem(id) {
    const workItem = this.store.getWorkItem(id);
    if (!workItem) throw new WorkItemNotFoundError(id);
    return workItem;
  }

  updateWorkItem(id, patch = {}) {
    const current = this.getWorkItem(id);
    if (Object.prototype.hasOwnProperty.call(patch, "acceptanceAssessment")
      || Object.prototype.hasOwnProperty.call(patch, "executionStatus")) {
      throw new WorkItemAcceptanceError(
        "WORK_ITEM_STATE_READ_ONLY",
        "acceptanceAssessment and executionStatus are managed by their dedicated workflows."
      );
    }
    if (["done", "complete", "completed"].includes(patch.status)
      && !completionSuggestionForWorkItem(current)) {
      throw new WorkItemAcceptanceError(
        "ACCEPTANCE_NOT_PROVEN",
        "The WorkItem cannot be completed because its current acceptance criteria have not been proven."
      );
    }

    const normalized = validateWorkItemInput(patch, "update");
    const nextPatch = { ...normalized };
    if (Object.prototype.hasOwnProperty.call(normalized, "acceptanceCriteria")
      && String(normalized.acceptanceCriteria ?? "").trim() !== String(current.acceptance_criteria ?? "").trim()) {
      nextPatch.acceptanceAssessment = null;
    }
    return this.emit("WorkItemChanged", this.store.updateWorkItem(id, nextPatch), "updated");
  }

  confirmWorkItemCompletion(id, input = {}) {
    const current = this.getWorkItem(id);
    if (input.confirmed !== true) {
      throw new WorkItemAcceptanceError(
        "USER_CONFIRMATION_REQUIRED",
        "Completing a WorkItem through this command requires explicit user confirmation."
      );
    }
    if (["done", "complete", "completed"].includes(current.status)) return current;
    if (!["in_progress", "doing", "running"].includes(current.status)) {
      throw new WorkItemAcceptanceError(
        "INVALID_STATUS_TRANSITION",
        `A WorkItem in status ${current.status} cannot be confirmed complete.`
      );
    }
    return this.emit(
      "WorkItemChanged",
      this.store.updateWorkItem(id, { status: "done" }),
      "user-confirmed-completion"
    );
  }

  rejectWorkItemAcceptance(id, input = {}) {
    const current = this.getWorkItem(id);
    if (input.rejected !== true) {
      throw new WorkItemAcceptanceError(
        "USER_REJECTION_REQUIRED",
        "Rejecting an automated acceptance result requires explicit user confirmation."
      );
    }
    const suggestion = completionSuggestionForWorkItem(current);
    if (!suggestion) {
      throw new WorkItemAcceptanceError(
        "ACCEPTANCE_NOT_PASSED",
        "This WorkItem does not have a current passing automated acceptance result."
      );
    }
    const assessment = {
      ...suggestion,
      status: "rejected",
      rejectedAt: new Date().toISOString()
    };
    delete assessment.recommended;
    return this.emit(
      "WorkItemChanged",
      this.store.updateWorkItem(id, {
        acceptanceAssessment: assessment,
        status: current.status
      }),
      "acceptance-rejected-by-user"
    );
  }

  recordAcceptanceAssessment(id, input = {}) {
    const workItem = this.getWorkItem(id);
    const sourceSessionId = String(input.sourceSessionId ?? "").trim();
    const session = sourceSessionId ? this.store.getSession(sourceSessionId) : null;
    if (!session) throw new SessionNotFoundError(sourceSessionId);
    if (session.workItemId !== id) {
      throw new WorkItemAcceptanceError(
        "ACCEPTANCE_SOURCE_MISMATCH",
        "The acceptance source Session is not bound to this WorkItem."
      );
    }

    const assessment = buildAcceptanceAssessment(workItem, input);
    const patch = {
      acceptanceAssessment: assessment,
      status: workItem.status
    };
    return this.emit(
      "WorkItemChanged",
      this.store.updateWorkItem(id, patch),
      assessment.status === "passed" ? "acceptance-passed" : "acceptance-not-proven"
    );
  }

  deleteWorkItem(id) {
    this.getWorkItem(id);
    const deleted = this.store.deleteWorkItem(id);
    this.emit("WorkItemChanged", { id }, "deleted");
    return deleted;
  }

  // ---- Session 归属（打通 Objective → WorkItem → Session 最后一环）----

  // 把一个已存在的 Session 归属到某个 WorkItem，自动带上其 Objective。
  // 返回更新后的 Session（含 objectiveId / workItemId）。
  bindSession(sessionId, workItemId) {
    const workItem = this.getWorkItem(workItemId);
    const existingSession = this.store.getSession(sessionId);
    if (!existingSession) throw new SessionNotFoundError(sessionId);
    const session = this.store.bindSessionToWorkItem(sessionId, workItemId, workItem.objective_id);
    this.emit("WorkItemChanged", this.store.getWorkItem(workItemId), "session-bound");
    return session;
  }

  // 列出某 WorkItem 名下所有 Session（按创建时间升序）。
  listSessionsByWorkItem(workItemId) {
    return this.store.listSessionsByWorkItem(workItemId);
  }

  // ---- 依赖编排 + 环检测 ----

  addDependency(workItemId, targetWorkItemId, type = "depends_on") {
    this.getWorkItem(workItemId);
    this.getWorkItem(targetWorkItemId);
    if (workItemId === targetWorkItemId) {
      throw new DependencyCycleError(workItemId, targetWorkItemId);
    }
    if (this.wouldCreateCycle(workItemId, targetWorkItemId)) {
      throw new DependencyCycleError(workItemId, targetWorkItemId);
    }
    return this.emit(
      "WorkItemChanged",
      this.store.addWorkItemDependency(workItemId, targetWorkItemId, type),
      "dependency-added"
    );
  }

  removeDependency(workItemId, targetWorkItemId) {
    const removed = this.store.removeWorkItemDependency(workItemId, targetWorkItemId);
    this.emit("WorkItemChanged", { id: workItemId, targetWorkItemId }, "dependency-removed");
    return removed;
  }

  listDependencies(workItemId) {
    return this.store.listWorkItemDependencies(workItemId);
  }

  listDependents(targetWorkItemId) {
    return this.store.listWorkItemDependents(targetWorkItemId);
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
      for (const dep of this.store.listWorkItemDependencies(current)) {
        stack.push(dep.target_work_item_id);
      }
    }
    return false;
  }
}
