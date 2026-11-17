import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { coordinationDelegation } from "../domain/coordinationDelegation.mjs";
import { ExecutionChecklistRepository } from "../store/repositories/executionChecklistRepository.mjs";
import { validateChecklistDependencies } from "../domain/executionChecklistPolicy.mjs";

const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const text = (value, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("CHECKLIST_INVALID_TEXT", 400);
  return value.trim();
};
const states = new Set(["pending", "inProgress", "completed", "blocked"]);

// Task-owned plans; only explicitly enabled runtimes participate in Session continuation.
export class ExecutionChecklistService {
  constructor({ store, changed = () => {}, clock = () => new Date().toISOString() }) {
    Object.assign(this, { store, changed, clock });
    this.repository = new ExecutionChecklistRepository(store);
  }
  read(taskId, options = {}) {
    const selected = this.repository.get(taskId, options);
    if (selected) return selected;
    if (options.planId || options.instructionId) return null;
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
  scope(context) {
    const { metadata, binding } = context ?? {};
    const logical = metadata?.logicalSessionId && this.store.getLogicalSession(metadata.logicalSessionId);
    const session = logical && this.store.getSession(logical.legacySessionId);
    if (!binding || !session?.taskId || metadata.taskId !== session.taskId) fail("CHECKLIST_SESSION_SCOPE_REQUIRED", 403);
    const task = this.task(session.taskId);
    const delegation = binding.delegation;
    if (task.current_session_id !== session.id && !delegation) fail("CHECKLIST_SESSION_LEASE_CHANGED", 403);
    const ownerLogicalSessionId=delegation?.mainSessionId??logical.logicalSessionId;
    const operation=this.store.getRunningAgentTaskForSession(session.id);
    return { task, logical, session, ownerLogicalSessionId,
      instructionId:operation?.source?.checklistContinuation?.instructionId??operation?.taskId??session.external?.activeTurnId,
      planId:operation?.source?.checklistContinuation?.planId??operation?.source?.executionPlanId??null };
  }
  save(value, {makeCurrent=false} = {}) {
    value.completedCount = value.steps.filter(step => step.status === "completed").length;
    value.updatedAt = this.clock();
    this.repository.save(value);
    const current=this.store.selectOne('SELECT body_json FROM execution_checklists WHERE task_id=?',[value.taskId]);
    const currentPlan=current&&JSON.parse(current.body_json);
    // Updating an older concurrent plan must not replace the current pointer.
    if(makeCurrent||!currentPlan||currentPlan.planId===value.planId)this.store.db.run(`INSERT INTO execution_checklists(task_id,session_id,body_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id,body_json=excluded.body_json,updated_at=excluded.updated_at`,
    [value.taskId, value.logicalSessionId, JSON.stringify(value), value.updatedAt]);
    // Stable timeline identity within a batch; a new batch retains the closed
    // predecessor as a historical item. Closing only changes presentation.
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
    const runtime=this.repository.runtime(planId);
    const continuation=runtime?{enabled:runtime.enabled,state:runtime.state,generation:runtime.generation,pauseReason:runtime.pauseReason??null,
      reason:runtime.reason??null,nextStepIds:runtime.nextStepIds??[],canPause:runtime.enabled&&!['completed','cancelled','paused_user'].includes(runtime.state),
      canResume:['paused_user','needs_attention'].includes(runtime.state)}:null;
    return { schemaVersion, planId, taskId, revision, closed: value.closed === true, lifecycle, stopReason: runtime?.pauseReason??null, continuation, explanation, steps: steps.map(step => ({ ...step,
      ...(step.assignment ? { assignment: enrichAssignments ? this.resolveAssignment(taskId, step.assignment) : step.assignment } : {}) })), completedCount, updatedAt };
  }
  publish(value) { this.changed(value); }
  result(value, receipt = null) {
    return { checklist: value, receipt, remaining: value.steps.filter(step => step.status !== "completed"),
      instruction: this.repository.runtime(value.planId)?.enabled
        ? "这是持续推进执行清单；未完成事项必须有有效执行或明确依赖。关闭仅隐藏卡片；用户停止和预算暂停优先。完成标记不等于产品验收。"
        : "这是历史进度清单，不会自动激活。继续已授权工作并更新进度；关闭卡片不等于停止。" };
  }
  mutate(taskId, input, context = {}) {
    if (input.action === "close") {
      if (!this.store.getTask(taskId)) fail("TASK_NOT_FOUND", 404);
    } else this.task(taskId);
    if (!["create", "add", "edit", "remove", "move", "status", "assign", "unassign", "close"].includes(input.action)) fail("CHECKLIST_INVALID_ACTION", 400);
    if(context.model&&input.executionEnabled===false)fail('CHECKLIST_USER_CONTROL_REQUIRED',403);
    const operationId = text(input.operationId, 200);
    const allowed = ["operationId", "expectedRevision", "action", "itemId", "text", "condition", "status", "reason", "position", "steps", "itemIds", "taskId", "dispatchId", "planId", "phase", "dependsOnStepIds", "executionEnabled"];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail("CHECKLIST_UNKNOWN_FIELD", 400);
    let value, receipt, archived;
    this.store.runInTransaction(() => {
      value = this.read(taskId,input.planId?{planId:input.planId}:{});
      const replay = this.store.selectOne("SELECT * FROM execution_checklist_operations WHERE task_id=? AND operation_id=?", [taskId, operationId]);
      if (replay) {
        if (!isDeepStrictEqual(JSON.parse(replay.request_json), input)) fail("CHECKLIST_OPERATION_CONFLICT");
        receipt = JSON.parse(replay.receipt_json); value=this.read(taskId,receipt.planId?{planId:receipt.planId}:{});return;
      }
      if ((value?.revision ?? 0) !== input.expectedRevision) fail("CHECKLIST_STALE_REVISION");
      const owner=context.ownerLogicalSessionId??context.logicalSessionId;
      if (value && owner && value.logicalSessionId !== owner) fail("CHECKLIST_SESSION_LEASE_CHANGED", 403);
      if (input.action === "create") {
        if (!context.logicalSessionId || !context.turnId || !context.bindingId) fail("CHECKLIST_ACTIVE_TURN_REQUIRED", 403);
        const steps = input.steps;
        if (!Array.isArray(steps) || steps.length < 1 || steps.length > 200) fail("CHECKLIST_INVALID_STEPS", 400);
        const previousRevision = value?.revision ?? 0;
        const sourceOperationId=context.sourceOperationId??this.store.getRunningAgentTaskForSession(this.store.getLogicalSession(context.logicalSessionId)?.legacySessionId)?.taskId??null;
        const instructionRoot=sourceOperationId&&this.instructionRoot?.(sourceOperationId);
        const previousPlanId = value?.planId;
        if (value && (!context.instructionId || value.instructionId===(instructionRoot?.instructionId??context.instructionId) || value.lifecycle==='completed')) {
          value.closed = true;
          value.revision++;
          this.save(value);
          archived = value;
          const previousRuntime=this.repository.runtime(value.planId);
          if(previousRuntime)this.repository.saveRuntime(value.planId,{...previousRuntime,state:'cancelled',pauseReason:'superseded',generation:previousRuntime.generation+1});
        }
        value = { schemaVersion: 1, planId: previousPlanId ? `checklist:${taskId}:${randomUUID()}` : `checklist:${taskId}`, taskId,
          revision: previousRevision + (archived ? 1 : 0), closed: false,
          logicalSessionId: owner, instructionId:instructionRoot?.instructionId??context.instructionId??context.turnId,anchorTurnId: context.turnId, anchorBindingId: context.bindingId,
          lifecycle: "active", stopReason: null, explanation: null, createdAt: this.clock(), updatedAt:this.clock(), steps: steps.map((step, ordinal) => ({
            stepId: `item:${randomUUID()}`, ordinal, text: text(step.text), condition: step.condition ? text(step.condition) : "",
            status: "pending", reason: null,phase:step.phase??"implementation",dependsOnStepIds:step.dependsOnStepIds??[] })) };
        this.repository.save(value);
        this.repository.saveRuntime(value.planId,{enabled:context.model===true&&input.executionEnabled!==false,state:'idle',generation:0,
          responsibleSessionId:coordinationDelegation(this.store,context.logicalSessionId)?.kind==='request-shadow'?owner:context.logicalSessionId,ownerSessionId:owner,pauseReason:null,nextStepIds:[],
          instructionId:value.instructionId,sourceOperationId});
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
            const resolved=this.resolveAssignment(taskId, assignment, true);
            assignment={...assignment,...(resolved.taskId?{taskId:resolved.taskId}:{}),title:resolved.title};
          }
          for (const step of selected) {
            if (assignment) step.assignment = {...assignment,assignedAt:this.clock(),executionRevision:step.executionRevision??0};
            else delete step.assignment;
          }
        } else {
        const index = value.steps.findIndex(step => step.stepId === input.itemId);
        if (input.action === "add") {
          if (value.steps.length >= 200) fail("CHECKLIST_TOO_MANY_ITEMS", 400);
          value.steps.push({ stepId: `item:${randomUUID()}`, ordinal: value.steps.length, text: text(input.text),
            condition: input.condition ? text(input.condition) : "", status: "pending", reason: null, phase:input.phase??"implementation", dependsOnStepIds:input.dependsOnStepIds??[] });
        } else {
          if (index < 0) fail("CHECKLIST_ITEM_NOT_FOUND", 404);
          const step = value.steps[index];
          if (input.action === "remove") value.steps.splice(index, 1);
          else if (input.action === "edit") {
            if (input.text !== undefined) step.text = text(input.text);
            if (input.condition !== undefined) step.condition = input.condition === "" ? "" : text(input.condition);
            // A new definition cannot inherit an old completion claim.
            if (step.status === "completed") { step.status = "pending"; step.reason = null; }
            if(input.phase!==undefined)step.phase=input.phase;
            if(input.dependsOnStepIds!==undefined)step.dependsOnStepIds=input.dependsOnStepIds;
            step.executionRevision=(step.executionRevision??0)+1;
            step.definitionChangedAt=this.clock();
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
        if(['edit','remove','assign','unassign','status'].includes(input.action))for(const id of input.itemIds??[input.itemId])if(id)this.repository.clearWait(value.planId,id);
        value.steps.forEach((step, ordinal) => { step.ordinal = ordinal; });
        value.lifecycle = value.steps.length && value.steps.every(step => step.status === "completed") ? "completed" : "active";
        value.stopReason = null;
      }
      value.revision++;
      if(value.steps.some(step=>!['implementation','verification','delivery'].includes(step.phase??'implementation')))fail('CHECKLIST_INVALID_PHASE',400);
      validateChecklistDependencies(value.steps);
      this.save(value,{makeCurrent:input.action==='create'});
      receipt = { operationId, revision: value.revision, planId:value.planId };
      this.store.db.run("INSERT INTO execution_checklist_operations VALUES(?,?,?,?)", [taskId, operationId, JSON.stringify(input), JSON.stringify(receipt)]);
    });
    if (archived) this.publish(archived);
    this.publish(value);
    return this.result(this.read(taskId,{planId:value.planId}), receipt);
  }

  control(taskId, input, user = {}) {
    const {planId,action,expectedRevision}=input;
    if(!user.authenticated || !planId || !['pause','resume'].includes(action))fail('CHECKLIST_USER_CONTROL_REQUIRED',403);
    let result;
    this.store.runInTransaction(()=>{
      const value=this.read(taskId,{planId});if(!value)fail('CHECKLIST_NOT_FOUND',404);
      const receipt=input.operationId&&this.store.selectOne('SELECT * FROM execution_checklist_operations WHERE task_id=? AND operation_id=?',[taskId,input.operationId]);
      if(receipt){if(!isDeepStrictEqual(JSON.parse(receipt.request_json),input))fail('CHECKLIST_OPERATION_CONFLICT');result=this.result(value,JSON.parse(receipt.receipt_json));return;}
      if(value.revision!==expectedRevision)fail('CHECKLIST_STALE_REVISION');
      this.task(taskId);
      const runtime=this.repository.runtime(planId)??{enabled:true,state:'idle',generation:0,responsibleSessionId:value.logicalSessionId,instructionId:value.instructionId};
      if(action==='resume'&&runtime.pauseReason==='budget')fail('VERIFICATION_BUDGET_EXHAUSTED');
      this.repository.saveRuntime(planId,{...runtime,enabled:true,generation:runtime.generation+1,operationId:null,lastCompletedKey:null,lastNoProgress:null,
        state:action==='pause'?'paused_user':'idle',pauseReason:action==='pause'?'user':null,reason:null});
      value.revision++;this.save(value);
      const accepted={operationId:input.operationId??null,planId,revision:value.revision};
      if(input.operationId)this.store.db.run('INSERT INTO execution_checklist_operations VALUES(?,?,?,?)',[taskId,input.operationId,JSON.stringify(input),JSON.stringify(accepted)]);
      result=this.result(value,accepted);
    });
    this.publish(result.checklist);return result;
  }
  retireLegacyContinuations() {
    // Withdraw only unsent messages from the removed automatic scheduler.
    // Ordinary user messages and already running operations are untouched.
    this.store.db.run(`UPDATE agent_operations SET status='cancelled',last_error='Checklist automatic continuation removed'
      WHERE status='queued' AND json_extract(source_json,'$.checklistTaskId') IS NOT NULL`);
  }
}
