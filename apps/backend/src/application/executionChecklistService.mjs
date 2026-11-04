import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const text = (value, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("CHECKLIST_INVALID_TEXT", 400);
  return value.trim();
};
const states = new Set(["pending", "inProgress", "completed", "blocked"]);

// Task-owned progress; Session alone holds the execution lease. The existing
// mailbox and AgentWork queue own delivery, never this state repository.
export class ExecutionChecklistService {
  constructor({ store, mailbox, changed = () => {}, wake = () => {}, canExecute = () => true, clock = () => new Date().toISOString() }) {
    Object.assign(this, { store, mailbox, changed, wake, canExecute, clock });
  }
  read(taskId) {
    const row = this.store.selectOne("SELECT body_json FROM execution_checklists WHERE task_id=?", [taskId]);
    return row ? JSON.parse(row.body_json) : null;
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
    // A single stable item in the existing timeline. Status changes never
    // append duplicate cards or become Provider plan/Goal authority.
    const logical = this.store.getLogicalSession(value.logicalSessionId);
    if (logical?.legacySessionId) this.store.upsertTimelineItemProjection(logical.legacySessionId, {
      id: value.planId, type: "executionChecklist", title: "执行清单", text: `执行清单 ${value.completedCount}/${value.steps.length}`,
      turnId: value.anchorTurnId, turnStatus: "completed", status: "completed", bindingId: value.anchorBindingId,
      createdAt: value.createdAt, rawMetadataJSON: JSON.stringify({ executionPlan: this.display(value) })
    });
    this.store.scheduleSave();
  }
  display(value) {
    if (!value) return null;
    const { schemaVersion, planId, taskId, revision, lifecycle, stopReason, explanation, steps, completedCount, updatedAt } = value;
    const logical = this.store.getLogicalSession(value.logicalSessionId);
    let executionAvailable = false;
    try { executionAvailable = Boolean(logical && this.canExecute(logical)); } catch {}
    return { schemaVersion, planId, taskId, revision, lifecycle, stopReason, explanation, steps, completedCount, updatedAt, executionAvailable };
  }
  publish(value) { this.changed(value); }
  result(value, receipt = null) {
    return { checklist: value, receipt, remaining: value.steps.filter(step => step.status !== "completed"),
      instruction: value.lifecycle === "active" ? "继续当前已授权范围内可做的事项；全部完成即停止，开发项完成不要求逐项构建。" : `停止自动推进：${value.stopReason ?? value.lifecycle}` };
  }
  mutate(taskId, input, context = {}) {
    const task = this.task(taskId);
    const operationId = text(input.operationId, 200);
    const allowed = ["operationId", "expectedRevision", "action", "itemId", "text", "condition", "status", "reason", "position", "steps"];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail("CHECKLIST_UNKNOWN_FIELD", 400);
    let value, receipt, refreshQueued = false;
    this.store.runInTransaction(() => {
      value = this.read(taskId);
      const replay = this.store.selectOne("SELECT * FROM execution_checklist_operations WHERE task_id=? AND operation_id=?", [taskId, operationId]);
      if (replay) {
        if (!isDeepStrictEqual(JSON.parse(replay.request_json), input)) fail("CHECKLIST_OPERATION_CONFLICT");
        receipt = JSON.parse(replay.receipt_json); return;
      }
      if ((value?.revision ?? 0) !== input.expectedRevision) fail("CHECKLIST_STALE_REVISION");
      if (value && context.logicalSessionId && value.logicalSessionId !== context.logicalSessionId) fail("CHECKLIST_SESSION_LEASE_CHANGED", 403);
      if (value && !["pause", "resume", "cancel"].includes(input.action)) {
        refreshQueued = Boolean(this.store.selectOne("SELECT 1 FROM agent_operations WHERE status='queued' AND json_extract(source_json,'$.checklistTaskId')=?", [taskId]));
        if (refreshQueued) { value.generation++; this.cancelQueued(value); }
      }
      if (input.action === "create") {
        if (value) fail("CHECKLIST_ALREADY_EXISTS");
        if (!context.logicalSessionId || !context.turnId || !context.bindingId) fail("CHECKLIST_ACTIVE_TURN_REQUIRED", 403);
        const steps = input.steps;
        if (!Array.isArray(steps) || steps.length < 1 || steps.length > 200) fail("CHECKLIST_INVALID_STEPS", 400);
        value = { schemaVersion: 1, planId: `checklist:${taskId}`, taskId, revision: 0, taskRevision: task.revision,
          logicalSessionId: context.logicalSessionId, anchorTurnId: context.turnId, anchorBindingId: context.bindingId,
          observedBindingId: context.bindingId, observedTurnId: context.turnId, generation: 1, lifecycle: "active",
          stopReason: null, explanation: null, createdAt: this.clock(), remainingTurns: 5,
          expiresAt: new Date(Date.parse(this.clock()) + 30 * 60_000).toISOString(), progressSerial: 0, lastProgressSerial: -1,
          authorizationRef: `task:${taskId}:revision:${task.revision}`, steps: steps.map((step, ordinal) => ({
            stepId: `item:${randomUUID()}`, ordinal, text: text(step.text), condition: step.condition ? text(step.condition) : "",
            status: "pending", reason: null })) };
      } else {
        if (!value) fail("CHECKLIST_NOT_FOUND", 404);
        const control = ["pause", "resume", "cancel"].includes(input.action);
        if (control) {
          if (context.model) fail("CHECKLIST_USER_CONTROL_REQUIRED", 403);
          value.generation++;
          value.lifecycle = { pause: "paused", resume: "active", cancel: "cancelled" }[input.action];
          value.stopReason = input.action === "resume" ? null : input.action;
          if (input.action === "resume") {
            value.taskRevision = task.revision; value.authorizationRef = `task:${taskId}:revision:${task.revision}`; value.remainingTurns = 5;
            value.expiresAt = new Date(Date.parse(this.clock()) + 30 * 60_000).toISOString();
            value.lastProgressSerial = value.progressSerial - 1;
          }
          this.cancelQueued(value);
        } else {
          if (value.lifecycle === "cancelled") fail("CHECKLIST_CANCELLED");
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
              const wasCompleted = step.status === "completed";
              step.status = input.status;
              step.reason = input.reason ? text(input.reason) : null;
              if (step.status === "blocked" && !step.reason) fail("CHECKLIST_BLOCK_REASON_REQUIRED", 400);
              if (step.status === "completed" && !wasCompleted) value.progressSerial++;
            } else fail("CHECKLIST_INVALID_ACTION", 400);
          }
          value.steps.forEach((step, ordinal) => { step.ordinal = ordinal; });
          if (value.steps.length && value.steps.every(step => step.status === "completed")) {
            value.lifecycle = "completed"; value.stopReason = "all_completed"; this.cancelQueued(value);
          } else if (value.lifecycle === "completed") {
            value.lifecycle = "paused"; value.stopReason = "checklist_reopened";
          }
        }
      }
      value.revision++;
      if (context.turnId) { value.observedTurnId = context.turnId; value.observedBindingId = context.bindingId; }
      this.save(value);
      receipt = { operationId, revision: value.revision };
      this.store.db.run("INSERT INTO execution_checklist_operations VALUES(?,?,?,?)", [taskId, operationId, JSON.stringify(input), JSON.stringify(receipt)]);
    });
    this.publish(value);
    if (input.action === "resume" || (refreshQueued && value.lifecycle === "active")) {
      value.lastProgressSerial = -1;
      this.continue(value, null);
    }
    return this.result(this.read(taskId), receipt);
  }
  cancelQueued(value) {
    this.store.db.run(`UPDATE agent_operations SET status='cancelled',last_error='Checklist stopped or superseded'
      WHERE status='queued' AND json_extract(source_json,'$.checklistTaskId')=?`, [value.taskId]);
  }
  stop(value, reason, state = "blocked") {
    value.lifecycle = state; value.stopReason = reason; value.generation++; value.revision++;
    this.store.runInTransaction(() => { this.cancelQueued(value); this.save(value); });
    this.publish(value);
  }
  validate(value) {
    const task = this.task(value.taskId), logical = this.store.getLogicalSession(value.logicalSessionId);
    if (["cancelled", "completed"].includes(task.lifecycle_state) || value.lifecycle !== "active" || task.revision !== value.taskRevision
      || task.current_session_id !== logical?.legacySessionId || logical?.activeBinding?.state !== "active") fail("CHECKLIST_AUTHORIZATION_CHANGED");
    if (Date.parse(value.expiresAt) <= Date.parse(this.clock())) fail("CHECKLIST_EXPIRED");
    if (!this.canExecute(logical)) fail("CHECKLIST_PROVIDER_UNSUPPORTED");
    if (this.mailbox.settings(value.logicalSessionId).paused) fail("CHECKLIST_MAILBOX_PAUSED");
    return logical;
  }
  validateOperation(operation) {
    if (!operation.source?.checklistTaskId) return;
    const value = this.read(operation.source.checklistTaskId);
    if (!value || value.generation !== operation.source.checklistGeneration) fail("CHECKLIST_GENERATION_CHANGED");
    const logical = this.validate(value);
    if (logical.legacySessionId !== operation.sessionId || logical.activeBinding.bindingId !== operation.source.checklistBindingId) fail("CHECKLIST_BINDING_CHANGED");
  }
  onTerminal({ event, projection, completedWork }) {
    const session = projection?.session;
    if (!session?.taskId) return;
    const value = this.read(session.taskId);
    if (!value || value.lifecycle !== "active") return;
    if (completedWork?.source?.checklistTaskId === value.taskId
      && completedWork.source.checklistGeneration === value.generation
      && completedWork.source.checklistBindingId === event.bindingId) {
      value.observedTurnId = event.turnId; value.observedBindingId = event.bindingId;
    }
    if (value.observedTurnId !== event.turnId || value.observedBindingId !== event.bindingId) return;
    if (event.type !== "turn.completed" || projection.terminalStatus === "failed" || projection.terminalStatus === "cancelled"
      || event.payload?.suppressAutomaticContinuation) { this.stop(value, "turn_not_confirmed"); return; }
    this.continue(value, event);
  }
  continue(value, event) {
    if (event && this.store.selectOne("SELECT 1 FROM execution_checklist_continuations WHERE task_id=? AND binding_id=? AND turn_id=?", [value.taskId, event.bindingId, event.turnId])) return;
    let logical;
    try { logical = this.validate(value); } catch (error) { this.stop(value, error.code); return; }
    if (!value.steps.length || value.steps.every(step => step.status === "completed")) { this.stop(value, "all_completed", "completed"); return; }
    if (value.steps.some(step => step.status === "blocked")) { this.stop(value, "item_blocked"); return; }
    if (value.remainingTurns <= 0) { this.stop(value, "turn_budget_exhausted"); return; }
    if (value.progressSerial === value.lastProgressSerial) { this.stop(value, "no_progress"); return; }
    let admitted;
    this.store.runInTransaction(() => {
      const binding = logical.activeBinding.bindingId, turn = event?.turnId ?? `resume:${value.generation}`;
      if (this.store.selectOne("SELECT 1 FROM execution_checklist_continuations WHERE task_id=? AND binding_id=? AND turn_id=?", [value.taskId, binding, turn])) return;
      const operationId = `checklist-run:${randomUUID()}`;
      value.remainingTurns--; value.lastProgressSerial = value.progressSerial; value.revision++;
      this.store.db.run("INSERT INTO execution_checklist_continuations VALUES(?,?,?,?)", [value.taskId, binding, turn, operationId]);
      const session = this.store.getSession(logical.legacySessionId);
      const remaining = value.steps.filter(step => step.status !== "completed").map(step => ({ itemId: step.stepId, action: step.text, condition: step.condition }));
      const message = `继续同一 Task 已授权的执行清单；不扩大业务范围、不创建新任务、不重做结果不明的副作用。完成一项调用 corptie_execution_checklist_manage 更新；可连续完成多项，最后集中验证。完成全部、真实阻塞或用户暂停即停止。剩余清单：${JSON.stringify(remaining)}`;
      admitted = this.mailbox.enqueueExternalOperation({ taskId: operationId, sessionId: session.id, agentId: session.agentId,
        kind: "user", priority: 0, text: message, source: { type: "execution-checklist", checklistTaskId: value.taskId,
          checklistGeneration: value.generation, checklistBindingId: binding, messageContent: message } },
      { sourceType: "system", authorization: { ownerLogicalSessionId: value.logicalSessionId, sourceId: operationId, checklistTaskId: value.taskId, generation: value.generation } });
      this.save(value);
    });
    this.publish(value);
    if (admitted?.inserted) this.wake(logical.legacySessionId, admitted.task.taskId);
  }
  onStarted(operation, turnId) {
    if (!operation.source?.checklistTaskId) return;
    const value = this.read(operation.source.checklistTaskId);
    if (!value || value.generation !== operation.source.checklistGeneration || value.lifecycle !== "active") return;
    if (!turnId) { this.stop(value, "dispatch_result_unknown"); return; }
    value.observedTurnId = turnId; value.observedBindingId = operation.source.checklistBindingId;
    this.save(value);
  }
  onFailed(operation) {
    if (!operation.source?.checklistTaskId) return;
    const value = this.read(operation.source.checklistTaskId);
    if (value?.lifecycle === "active" && value.generation === operation.source.checklistGeneration) this.stop(value, "dispatch_result_unknown");
  }
  pauseSession(sessionId) {
    const session = this.store.getSession(sessionId), value = session?.taskId && this.read(session.taskId);
    if (value && value.lifecycle === "active") this.stop(value, "user_interrupted", "paused");
  }
  recover(register) {
    for (const row of this.store.selectAll("SELECT body_json FROM execution_checklists")) {
      const value = JSON.parse(row.body_json);
      if (value.lifecycle !== "active") continue;
      const work = this.store.selectAll(`SELECT * FROM agent_operations WHERE json_extract(source_json,'$.checklistTaskId')=? ORDER BY created_at DESC LIMIT 1`, [value.taskId])[0];
      const source = work ? JSON.parse(work.source_json) : null;
      if (work?.status === "queued" && !source.mailboxDispatchAttempted) {
        try { this.validateOperation({ sessionId: work.session_id, source }); register(work.session_id, work.task_id); }
        catch (error) { this.stop(value, error.code); }
      } else this.stop(value, "restart_requires_reconciliation");
    }
  }
}
