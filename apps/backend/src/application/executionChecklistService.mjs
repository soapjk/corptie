import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const text = (value, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("CHECKLIST_INVALID_TEXT", 400);
  return value.trim();
};
const states = new Set(["pending", "inProgress", "completed", "blocked"]);

// Task-owned progress only. Session execution is independent of checklist state.
export class ExecutionChecklistService {
  constructor({ store, changed = () => {}, clock = () => new Date().toISOString() }) {
    Object.assign(this, { store, changed, clock });
  }
  read(taskId) {
    const row = this.store.selectOne("SELECT body_json FROM execution_checklists WHERE task_id=?", [taskId]);
    if (!row) return null;
    const value = JSON.parse(row.body_json);
    // Old execution leases are ignored; only item progress determines display.
    value.lifecycle = value.steps.length && value.steps.every(step => step.status === "completed") ? "completed" : "active";
    value.stopReason = null;
    return value;
  }
  task(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) fail("TASK_NOT_FOUND", 404);
    if (task.archived || task.deletion_status || ["cancelled"].includes(task.lifecycle_state)) fail("CHECKLIST_TASK_INACTIVE");
    return task;
  }
  scope(metadata) {
    const logical = this.store.getLogicalSession(metadata?.sessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(metadata?.sessionId);
    const session = logical && this.store.getSession(logical.legacySessionId);
    if (!session?.taskId || logical.activeBinding?.state !== "active"
      || metadata.providerBindingId !== logical.activeBinding.bindingId
      || (metadata.taskId && metadata.taskId !== session.taskId)) fail("CHECKLIST_SESSION_SCOPE_REQUIRED", 403);
    const task = this.task(session.taskId);
    if (task.current_session_id !== session.id) fail("CHECKLIST_SESSION_LEASE_CHANGED", 403);
    return { task, logical, session };
  }
  save(value) {
    value.completedCount = value.steps.filter(step => step.status === "completed").length;
    value.updatedAt = this.clock();
    this.store.db.run(`INSERT INTO execution_checklists(task_id,session_id,body_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id,body_json=excluded.body_json,updated_at=excluded.updated_at`,
    [value.taskId, value.logicalSessionId, JSON.stringify(value), value.updatedAt]);
    // Stable timeline identity within a batch; a new batch retains the closed
    // predecessor as a historical item. Closing never controls execution.
    const logical = this.store.getLogicalSession(value.logicalSessionId);
    if (logical?.legacySessionId) this.store.upsertTimelineItemProjection(logical.legacySessionId, {
      id: value.planId, type: "executionChecklist", title: "执行清单", text: `执行清单 ${value.completedCount}/${value.steps.length}`,
      turnId: value.anchorTurnId, turnStatus: "completed", status: "completed", bindingId: value.anchorBindingId,
      createdAt: value.createdAt, rawMetadataJSON: JSON.stringify({ executionPlan: this.display(value, false) })
    });
    this.store.scheduleSave();
  }
  resolveAssignment(parentTaskId, assignment, strict = false) {
    if (!assignment) return null;
    const dispatch = assignment.dispatchId && this.store.selectOne(
      "SELECT * FROM task_coordination_dispatches WHERE dispatch_id=?", [assignment.dispatchId]);
    const taskId = assignment.taskId ?? dispatch?.target_task_id ?? null;
    const task = taskId && this.store.getTask(taskId);
    const parent = this.store.getTask(parentTaskId);
    const invalid = (assignment.dispatchId && (!dispatch || dispatch.parent_task_id !== parentTaskId))
      || (assignment.taskId && dispatch?.target_task_id && assignment.taskId !== dispatch.target_task_id)
      || (taskId && (!task || task.parent_task_id !== parentTaskId || task.work_id !== parent?.work_id));
    if (invalid) {
      if (strict) fail("CHECKLIST_ASSIGNMENT_SCOPE_INVALID", 403);
      return { ...assignment, title: "关联任务不可用", status: "unavailable" };
    }
    const session = task?.current_session_id && this.store.getSession(task.current_session_id);
    let title = task?.title;
    if (!title && dispatch?.request_json) {
      try { title = JSON.parse(dispatch.request_json).creation?.title; } catch {}
    }
    return { ...assignment, taskId, title: title ?? "正在创建子任务",
      sessionId: session?.id ?? null,
      status: task?.lifecycle_state === "done" ? "done"
        : ["running", "blocked"].includes(session?.status) ? session.status
        : dispatch?.status ?? session?.status ?? task?.lifecycle_state ?? "pending",
      reason: dispatch?.error_message ?? null };
  }
  display(value, enrichAssignments = true) {
    if (!value) return null;
    const { schemaVersion, planId, taskId, revision, explanation, steps, completedCount, updatedAt } = value;
    const lifecycle = steps.length && steps.every(step => step.status === "completed") ? "completed" : "active";
    return { schemaVersion, planId, taskId, revision, closed: value.closed === true, lifecycle, stopReason: null, explanation, steps: steps.map(step => ({ ...step,
      ...(step.assignment ? { assignment: enrichAssignments ? this.resolveAssignment(taskId, step.assignment) : step.assignment } : {}) })), completedCount, updatedAt };
  }
  publish(value) { this.changed(value); }
  result(value, receipt = null) {
    return { checklist: value, receipt, remaining: value.steps.filter(step => step.status !== "completed"),
      instruction: "清单只记录事项进度，不控制会话执行；由模型继续已授权工作，完成后更新事项。" };
  }
  mutate(taskId, input, context = {}) {
    if (input.action === "close") {
      if (!this.store.getTask(taskId)) fail("TASK_NOT_FOUND", 404);
    } else this.task(taskId);
    if (!["create", "add", "edit", "remove", "move", "status", "assign", "unassign", "close"].includes(input.action)) fail("CHECKLIST_INVALID_ACTION", 400);
    const operationId = text(input.operationId, 200);
    const allowed = ["operationId", "expectedRevision", "action", "itemId", "text", "condition", "status", "reason", "position", "steps", "itemIds", "taskId", "dispatchId"];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail("CHECKLIST_UNKNOWN_FIELD", 400);
    let value, receipt, archived;
    this.store.runInTransaction(() => {
      value = this.read(taskId);
      const replay = this.store.selectOne("SELECT * FROM execution_checklist_operations WHERE task_id=? AND operation_id=?", [taskId, operationId]);
      if (replay) {
        if (!isDeepStrictEqual(JSON.parse(replay.request_json), input)) fail("CHECKLIST_OPERATION_CONFLICT");
        receipt = JSON.parse(replay.receipt_json); return;
      }
      if ((value?.revision ?? 0) !== input.expectedRevision) fail("CHECKLIST_STALE_REVISION");
      if (value && context.logicalSessionId && value.logicalSessionId !== context.logicalSessionId) fail("CHECKLIST_SESSION_LEASE_CHANGED", 403);
      if (input.action === "create") {
        if (!context.logicalSessionId || !context.turnId || !context.bindingId) fail("CHECKLIST_ACTIVE_TURN_REQUIRED", 403);
        const steps = input.steps;
        if (!Array.isArray(steps) || steps.length < 1 || steps.length > 200) fail("CHECKLIST_INVALID_STEPS", 400);
        const previousRevision = value?.revision ?? 0;
        const previousPlanId = value?.planId;
        if (value) {
          value.closed = true;
          value.revision++;
          this.save(value);
          archived = value;
        }
        value = { schemaVersion: 1, planId: previousPlanId ? `checklist:${taskId}:${randomUUID()}` : `checklist:${taskId}`, taskId,
          revision: previousRevision + (archived ? 1 : 0), closed: false,
          logicalSessionId: context.logicalSessionId, anchorTurnId: context.turnId, anchorBindingId: context.bindingId,
          lifecycle: "active", stopReason: null, explanation: null, createdAt: this.clock(), steps: steps.map((step, ordinal) => ({
            stepId: `item:${randomUUID()}`, ordinal, text: text(step.text), condition: step.condition ? text(step.condition) : "",
            status: "pending", reason: null })) };
      } else if (input.action === "close") {
        if (!value) fail("CHECKLIST_NOT_FOUND", 404);
        value.closed = true;
      } else {
        if (!value) fail("CHECKLIST_NOT_FOUND", 404);
        if (["assign", "unassign", "close"].includes(input.action)) {
          const ids = input.itemIds ?? (input.itemId ? [input.itemId] : []);
          if (!Array.isArray(ids) || !ids.length || ids.length > 200) fail("CHECKLIST_INVALID_ITEMS", 400);
          const selected = ids.map(id => value.steps.find(step => step.stepId === id));
          if (selected.some(step => !step)) fail("CHECKLIST_ITEM_NOT_FOUND", 404);
          let assignment;
          if (input.action === "assign") {
            if (!input.taskId && !input.dispatchId) fail("CHECKLIST_ASSIGNMENT_REQUIRED", 400);
            assignment = { ...(input.taskId ? { taskId: text(input.taskId, 200) } : {}),
              ...(input.dispatchId ? { dispatchId: text(input.dispatchId, 200) } : {}) };
            this.resolveAssignment(taskId, assignment, true);
          }
          for (const step of selected) {
            if (assignment) step.assignment = assignment;
            else delete step.assignment;
          }
        } else {
        const index = value.steps.findIndex(step => step.stepId === input.itemId);
        if (input.action === "add") {
          if (value.steps.length >= 200) fail("CHECKLIST_TOO_MANY_ITEMS", 400);
          value.steps.push({ stepId: `item:${randomUUID()}`, ordinal: value.steps.length, text: text(input.text),
            condition: input.condition ? text(input.condition) : "", status: "pending", reason: null });
        } else {
          if (index < 0) fail("CHECKLIST_ITEM_NOT_FOUND", 404);
          const step = value.steps[index];
          if (input.action === "remove") value.steps.splice(index, 1);
          else if (input.action === "edit") {
            if (input.text !== undefined) step.text = text(input.text);
            if (input.condition !== undefined) step.condition = input.condition === "" ? "" : text(input.condition);
            // A new definition cannot inherit an old completion claim.
            if (step.status === "completed") { step.status = "pending"; step.reason = null; }
          } else if (input.action === "move") {
            if (!Number.isInteger(input.position) || input.position < 0 || input.position >= value.steps.length) fail("CHECKLIST_INVALID_POSITION", 400);
            value.steps.splice(index, 1); value.steps.splice(input.position, 0, step);
          } else if (input.action === "status") {
            if (!states.has(input.status)) fail("CHECKLIST_INVALID_STATUS", 400);
            step.status = input.status;
            step.reason = input.reason ? text(input.reason) : null;
            if (step.status === "blocked" && !step.reason) fail("CHECKLIST_BLOCK_REASON_REQUIRED", 400);
          } else fail("CHECKLIST_INVALID_ACTION", 400);
        }
        }
        value.steps.forEach((step, ordinal) => { step.ordinal = ordinal; });
        value.lifecycle = value.steps.length && value.steps.every(step => step.status === "completed") ? "completed" : "active";
        value.stopReason = null;
      }
      value.revision++;
      this.save(value);
      receipt = { operationId, revision: value.revision };
      this.store.db.run("INSERT INTO execution_checklist_operations VALUES(?,?,?,?)", [taskId, operationId, JSON.stringify(input), JSON.stringify(receipt)]);
    });
    if (archived) this.publish(archived);
    this.publish(value);
    return this.result(this.read(taskId), receipt);
  }
  retireLegacyContinuations() {
    // Withdraw only unsent messages from the removed automatic scheduler.
    // Ordinary user messages and already running operations are untouched.
    this.store.db.run(`UPDATE agent_operations SET status='cancelled',last_error='Checklist automatic continuation removed'
      WHERE status='queued' AND json_extract(source_json,'$.checklistTaskId') IS NOT NULL`);
  }
}
