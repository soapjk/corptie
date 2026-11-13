import { coordinationProgressFor } from './coordinationProgressService.mjs';
import { randomUUID } from "node:crypto";
import { CHILD_TASK_RESULT_NOTICE_PREFIX } from "../utils/sessionEventPresentation.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { createStartupTiming } from "../utils/startupTiming.mjs";

const terminal = new Set(["completed", "failed", "cancelled", "unknown"]);
const fail = (code, message = code, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };

// Durable admission/outbox metadata. Message ownership, delivery and execution
// remain in SessionMailboxService and the existing runtime queue.
export class TaskCoordinationService {
  constructor({ store, collaboration, mailbox, deletion, shadow = null, changed = () => {}, emitEvent = () => {} }) {
    Object.assign(this, { store, collaboration, mailbox, deletion, shadow, changed });
    this.progress = coordinationProgressFor(store);
    this.progress.onChanged = taskId => this.changed(taskId);
    this.progress.publishMilestone = (sessionId,item) => emitEvent("SessionCoordinationMilestone",{turnId:item.turnId,item,hasAgentMessage:true},{sessionId});
    this.running = new Map();
    this.creationChains = new Map();
    this.reportScheduled = false;
  }
  get(id) { return this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE dispatch_id=?", [id]); }
  listForParent(parentTaskId, limit = 20) {
    return this.store.selectAll("SELECT * FROM task_coordination_dispatches WHERE parent_task_id=? ORDER BY created_at DESC,dispatch_id LIMIT ?", [parentTaskId, Math.min(20, Math.max(1, limit))]).map(row => this.receipt(row));
  }
  update(id, fields) {
    const previous = this.get(id);
    if (previous?.report_message_id && ["status","error_code","error_message"].some(key=>Object.hasOwn(fields,key) && previous[key]!==fields[key])) {
      this.store.db.run("UPDATE task_coordination_dispatches SET report_generation=report_generation+1 WHERE dispatch_id=?", [id]);
      fields = { ...fields, report_message_id: null };
    }
    const allowed = ["target_task_id", "mailbox_message_id", "operation_id", "status", "error_code", "error_message", "report_message_id", "request_json"];
    const keys = Object.keys(fields).filter(key => allowed.includes(key));
    this.store.db.run(`UPDATE task_coordination_dispatches SET ${keys.map(key => `${key}=?`).join(",")},updated_at=? WHERE dispatch_id=?`,
      [...keys.map(key => fields[key]), new Date().toISOString(), id]);
    this.store.scheduleSave();
    this.progress.scheduleDispatch(id);
    const request = previous?.executor_session_id && this.requests?.forShadow(previous.executor_session_id);
    if (request) this.requests.wakeDependents(request.request_id);
    this.changed(this.get(id)?.parent_task_id);
  }
  receipt(row) {
    const task = row.target_task_id && this.store.getTask(row.target_task_id);
    const session = task?.current_session_id && this.store.getSession(task.current_session_id);
    return { dispatchId: row.dispatch_id, targetTaskId: row.target_task_id, mailboxMessageId: row.mailbox_message_id,
      deliveryId: row.operation_id, status: row.status === "running" && session?.status === "blocked" ? "blocked" : row.status,
      errorCode: row.error_code, errorMessage: row.error_message,
      executionEvidence: row.operation_id ? this.store.getAgentTask(row.operation_id)?.executionEvidence ?? null : null };
  }
  pendingCreation(parentTaskId, actorId, request, runtime) {
    if (request.action !== "create") return null;
    // Pending creation identity is scoped to the parent, contributor Role,
    // requested title, and Provider. A changed definition is explicitly reported,
    // never overwritten or silently treated as a delivered amendment.
    return this.store.selectAll(`SELECT * FROM task_coordination_dispatches
      WHERE parent_task_id=? AND source_role_id=? AND json_extract(request_json,'$.action')='create'
      AND json_extract(request_json,'$.creation.title')=? AND json_extract(request_json,'$.creation.agentId')=?
      AND json_extract(runtime_json,'$.providerId')=?
      AND (status IN ('accepted','preparing','waiting_workspace','queued','running','waiting_dispatch','blocked','unknown')
        OR (target_task_id IS NOT NULL AND status IN ('completed','cancelled')))
      ORDER BY created_at,dispatch_id`, [parentTaskId, actorId, request.creation.title, request.creation.agentId, runtime.providerId])
      .find(row => !row.target_task_id || (() => {
        const task = this.store.getTask(row.target_task_id);
        return task && !task.archived && !task.deletion_status && task.lifecycle_state !== "done";
      })()) ?? null;
  }
  reuseNotice(row, request) {
    const original = JSON.parse(row.request_json);
    const originalText = original.text ?? (row.mailbox_message_id
      ? this.store.selectOne("SELECT body FROM session_mailbox_messages WHERE message_id=?", [row.mailbox_message_id])?.body : null);
    const definitionChanged = JSON.stringify(original.creation) !== JSON.stringify(request.creation) || originalText !== request.text;
    return { ...this.receipt(row), reused: true, definitionChanged,
      reuseMessage: definitionChanged
        ? "已有同名同角色的创建请求，本次未重复创建；新定义与原请求不同，未覆盖或投递新增要求，请核对原请求后补充指令。"
        : "已有创建请求，复用原回执，未重复创建。" };
  }
  retireDuplicateCreation(row, canonical, request) {
    const notice = this.reuseNotice(canonical, request);
    this.update(row.dispatch_id, { status: "cancelled", error_code: "TASK_CREATION_DUPLICATE",
      error_message: `${notice.reuseMessage}原请求：${canonical.dispatch_id}` });
    this.scheduleReports();
  }
  acceptDispatch(metadata, actorId, input, progressContext = {}) {
    let scope = this.collaboration.coordinationScope(metadata, actorId);
    const requestOwner = this.requests?.forShadow(scope.logicalSessionId);
    const executorSessionId = scope.logicalSessionId;
    if (requestOwner) {
      this.requests.assertDelegate(scope.logicalSessionId);
      const main = this.store.getLogicalSession(requestOwner.main_session_id);
      scope = this.collaboration.coordinationScope({ sessionId: main.logicalSessionId, providerBindingId: main.activeBinding.bindingId }, actorId);
    }
    const delegation = this.shadow?.forShadow(scope.logicalSessionId);
    if (delegation) this.shadow.assertDelegate(scope.logicalSessionId, "dispatch_children");
    const progressScope = delegation ? { ...scope, logicalSessionId: delegation.main_session_id } : scope;
    if (!input || Object.keys(input).some(key => key !== "items")) fail("INVALID_DISPATCH", "Only items may be supplied.", 400);
    if (!Array.isArray(input?.items) || input.items.length < 1 || input.items.length > 100) fail("INVALID_TASK_BATCH_SIZE", "Dispatch accepts 1-100 items, internally admitted in groups of ten.", 400);
    if(input.items.length>10) {
      if(new Set(input.items.map(item=>item.idempotencyKey)).size!==input.items.length) fail("DUPLICATE_TASK_BATCH_KEY");
      const sourceTurnId=progressContext.sourceTurnId ?? scope.session.external?.activeTurnId ?? `dispatch-admission:${randomUUID()}`;
      const dispatches=[];let batchId=progressContext.batchId ?? null;
      for(let offset=0;offset<input.items.length;offset+=10) {
        const receipt=this.acceptDispatch(metadata,actorId,{items:input.items.slice(offset,offset+10)},{...progressContext,sourceTurnId,batchId});
        batchId=receipt.batchId;dispatches.push(...receipt.dispatches);
      }
      return {accepted:true,batchId,dispatches,instruction:"受理完成。立即交还控制权；不要轮询。"};
    }
    const prepared = input.items.map(item => this.collaboration.prepareCoordinationDispatch(scope, item, {
      replay: Boolean(this.store.selectOne("SELECT 1 FROM task_coordination_dispatches WHERE source_session_id=? AND idempotency_key=?", [scope.logicalSessionId, item?.idempotencyKey ?? null]))
    }));
    if (new Set(prepared.map(item => item.request.idempotencyKey)).size !== prepared.length) fail("DUPLICATE_TASK_BATCH_KEY");
    const rows = [], reused = new Map(), amendments = [];
    const shadowOwner = this.shadow && !delegation && scope.parent.coordination_enabled === 1
      ? this.shadow.reserve(scope.logicalSessionId) : null;
    const sourceTurnId = progressContext.sourceTurnId ?? scope.session.external?.activeTurnId ?? `dispatch-admission:${randomUUID()}`;
    let batch;
    this.store.runInTransaction(() => {
      for (const { request, runtime } of prepared) {
        const old = this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE source_session_id=? AND idempotency_key=?", [scope.logicalSessionId, request.idempotencyKey]);
        if (old) {
          const saved = JSON.parse(old.request_json);
          if (saved.text === null && old.mailbox_message_id) saved.text = this.store.selectOne("SELECT body FROM session_mailbox_messages WHERE message_id=?", [old.mailbox_message_id])?.body;
          if (JSON.stringify(saved) !== JSON.stringify(request)) fail("IDEMPOTENCY_CONFLICT", "Use the original dispatch key only for the same instruction.");
          rows.push(old); continue;
        }
        const pending = this.pendingCreation(scope.parent.id, actorId, request, runtime);
        if (pending) { rows.push(pending); reused.set(rows.length - 1, this.reuseNotice(pending, request)); continue; }
        const id = `dispatch:${randomUUID()}`, now = new Date().toISOString();
        this.store.db.run(`INSERT INTO task_coordination_dispatches
          (dispatch_id,source_session_id,parent_task_id,source_role_id,idempotency_key,request_json,runtime_json,mode_at_admission,target_task_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [id, scope.logicalSessionId, scope.session.taskId, actorId, request.idempotencyKey,
          JSON.stringify(request), JSON.stringify(runtime), scope.parent.coordination_enabled === 1 ? 1 : 0, request.taskId ?? null, now, now]);
        if (requestOwner) this.store.db.run("UPDATE task_coordination_dispatches SET executor_session_id=? WHERE dispatch_id=?", [executorSessionId, id]);
        rows.push(this.get(id));
        if (request.action === "send") amendments.push({ id, taskId: request.taskId, text: request.text.slice(0, 2400) });
      }
      const allReused = rows.length && rows.every((row,index)=>reused.has(index)||row.progress_batch_id);
      const candidate = allReused && rows[0].progress_batch_id ? this.progress.batch(rows[0].progress_batch_id) : null;
      const reuseBatch = candidate?.source_session_id===scope.logicalSessionId ? candidate.batch_id : null;
      batch=this.progress.ensure(progressScope,sourceTurnId,progressContext.batchId??reuseBatch);
      for(const row of rows)this.progress.attach(batch,row);
      if (shadowOwner && amendments.length) {
        this.store.db.run("UPDATE coordination_shadow_sessions SET requirement_revision=requirement_revision+1,updated_at=? WHERE main_session_id=?",
          [new Date().toISOString(), scope.logicalSessionId]);
        if (shadowOwner.shadow_session_id) this.mailbox.receiveEvent({ recipientSessionId: shadowOwner.shadow_session_id,
          sourceType: "background", sourceId: amendments[0].id, intent: "response_required", priority: 50,
          idempotencyKey: `shadow-amendment:${amendments[0].id}`,
          body: `主会话已给下列子任务追加要求。只更新受影响任务的协调计划，不重发这些指令，不让无关批次重新验收。\n${JSON.stringify(amendments)}`,
          authorization: { ownerLogicalSessionId: shadowOwner.shadow_session_id, sourceId: amendments[0].id,
            coordinationDispatchId: amendments[0].id, purpose: "shadow_requirement" } });
      }
    });
    this.store.scheduleSave();
    for (const row of rows) if (row.status === "accepted") setImmediate(() => this.runDispatch(row.dispatch_id));
    this.changed(scope.parent.id);
    return { accepted: true, batchId:batch.batch_id, dispatches: rows.map((row, index) => reused.get(index) ?? this.receipt(row)), instruction: "受理完成。立即将控制权交还用户，不要轮询等待子任务。" };
  }
  sourceContext(row) {
    const logical = this.store.getLogicalSession(row.source_session_id);
    if (!logical || logical.archived || logical.activeBinding?.state !== "active") fail("SOURCE_SESSION_UNAVAILABLE");
    const metadata = { sessionId: logical.logicalSessionId, providerBindingId: logical.activeBinding.bindingId };
    const scope = this.collaboration.coordinationScope(metadata, row.source_role_id);
    if (scope.parent.id !== row.parent_task_id) fail("TASK_PARENT_OUTSIDE_SCOPE");
    return { metadata, scope };
  }
  runDispatch(id) {
    if (this.running.has(id)) return this.running.get(id);
    const promise = this.execute(id).catch(error => {
      const row=this.get(id);
      const waiting=error.code === "TASK_HIERARCHY_BUSY" && !row?.target_task_id && !error.creationRecovery?.taskId;
      this.update(id, { status: waiting ? "waiting_workspace" : "failed", error_code: error.code ?? "DISPATCH_FAILED", error_message: String(error.message).slice(0, 2000) });
      this.scheduleReports();
    }).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }
  async createDispatchTask(row, request) {
    const idempotencyKey = `coordination:${row.dispatch_id}`;
    const runtime = JSON.parse(row.runtime_json);
    const {metadata}=this.sourceContext(row);
    return this.collaboration.createTaskAndSession(metadata,row.source_role_id,{
      ...request.creation,parentTaskId:row.parent_task_id,providerId:runtime.providerId,idempotencyKey
    },{runtimeConfiguration:runtime});
  }

  async execute(id) {
    let row = this.get(id);
    if (!row || !["accepted", "preparing", "waiting_workspace"].includes(row.status)) return;
    const { metadata, scope } = this.sourceContext(row), request = JSON.parse(row.request_json);
    const runtime = JSON.parse(row.runtime_json);
    const canonical = !row.target_task_id && this.pendingCreation(row.parent_task_id, row.source_role_id, request, runtime);
    if (canonical && canonical.dispatch_id !== id) { this.retireDuplicateCreation(row, canonical, request); return; }
    this.update(id, { status: "preparing", error_code: null, error_message: null });
    if (!row.target_task_id) {
      const prior = this.creationChains.get(row.parent_task_id) ?? Promise.resolve();
      const timing = createStartupTiming({ dispatchId: id, parentTaskId: row.parent_task_id,
        providerId: JSON.parse(row.runtime_json).providerId });
      const pending = timing.measure("dispatch.creation-chain", async span => {
        await span.measure("dispatch.wait-parent-startup", () => prior.catch(() => {}));
        // Recheck after the parent startup chain: admission/recovery may have
        // queued another equivalent request before this chain became available.
        const live = this.get(id);
        if (!live || live.status !== "preparing") return null;
        const existing = this.pendingCreation(row.parent_task_id, row.source_role_id, request, runtime);
        if (existing && existing.dispatch_id !== id) { this.retireDuplicateCreation(live, existing, request); return null; }
        return span.measure("dispatch.child-startup", () => this.createDispatchTask(row, request));
      });
      this.creationChains.set(row.parent_task_id, pending);
      const cleanup = () => { if (this.creationChains.get(row.parent_task_id) === pending) this.creationChains.delete(row.parent_task_id); };
      pending.then(cleanup, cleanup);
      const created = await pending;
      if (!created) return;
      this.update(id, { target_task_id: created.task.id });
      row = this.get(id);
    }
    this.sourceContext(row);
    const child = this.store.getTask(row.target_task_id);
    this.collaboration.assertDirectChild(scope, child);
    const logical = this.store.getLogicalSessionByLegacySessionId(child.current_session_id);
    if (!logical || logical.activeBinding?.state !== "active") fail("RECIPIENT_SESSION_UNAVAILABLE");
    // The outbox body is transferred exactly once into the existing mailbox;
    // after admission the mailbox is the only owner of the instruction text.
    this.store.runInTransaction(() => {
      const message = this.mailbox.receiveEvent({ recipientSessionId: logical.logicalSessionId, sourceType: "background", sourceId: id,
        body: request.text, intent: "action_required", idempotencyKey: id,
        authorization: { ownerLogicalSessionId: logical.logicalSessionId, sourceId: id,
          coordinationDispatchId: id, sourceSessionId: row.source_session_id, purpose: "child_instruction" } });
      const operationId = this.mailbox.raw(logical.logicalSessionId, message.messageId).operation_id;
      this.update(id, { mailbox_message_id: message.messageId, operation_id: operationId,
        status: "queued", request_json: JSON.stringify({ ...request, text: null }) });
    });
  }
  validateMailbox(row, authorization) {
    const dispatch = this.get(authorization.coordinationDispatchId);
    if (!dispatch || dispatch.dispatch_id !== row.source_id) fail("COORDINATION_AUTHORIZATION_REVOKED");
    const { scope } = this.sourceContext(dispatch);
    if (authorization.purpose === "shadow_requirement") {
      const delegation = this.shadow?.assertDelegate(row.recipient_session_id);
      if (!delegation || delegation.main_session_id !== dispatch.source_session_id) fail("COORDINATION_REPORT_SCOPE_INVALID");
      return;
    }
    if (authorization.purpose === "shadow_report") {
      const delegation = this.shadow?.assertDelegate(row.recipient_session_id, "review_results");
      if (!delegation || ![delegation.main_session_id, delegation.shadow_session_id].includes(dispatch.source_session_id)
        || !terminal.has(dispatch.status) || authorization.reportGeneration !== dispatch.report_generation) fail("COORDINATION_REPORT_SCOPE_INVALID");
      return;
    }
    if (authorization.purpose === "parent_report") {
      if (authorization.statusNotice && (!Number.isSafeInteger(authorization.reportGeneration)
        || authorization.reportGeneration < 0 || authorization.reportGeneration > dispatch.report_generation)) fail("COORDINATION_REPORT_SCOPE_INVALID");
      if (row.recipient_session_id !== dispatch.source_session_id
        || (!authorization.statusNotice && (!terminal.has(dispatch.status) || authorization.reportGeneration !== dispatch.report_generation))) fail("COORDINATION_REPORT_SCOPE_INVALID");
      return;
    }
    const child = this.store.getTask(dispatch.target_task_id);
    this.collaboration.assertDirectChild(scope, child);
    const recipient = this.store.getLogicalSession(row.recipient_session_id);
    if (!recipient || this.store.getSession(recipient.legacySessionId)?.taskId !== child.id || terminal.has(dispatch.status)) fail("COORDINATION_INSTRUCTION_STALE");
  }
  adoptedExecution(operation) {
    if (!operation?.taskId) return operation;
    const message = this.store.selectOne(`SELECT * FROM session_mailbox_messages
      WHERE operation_id=? AND disposition='adopted' AND adopted_turn_id IS NOT NULL`, [operation.taskId]);
    if (!message) return operation;
    const turn = this.store.getSessionTurn(message.adopted_provider_session_id,message.adopted_binding_id,message.adopted_turn_id);
    const status = turn?.executionStatus ?? turn?.execution_status;
    return { ...operation, status: ["running","blocked"].includes(status) ? "running"
      : ["completed","failed","cancelled"].includes(status) ? status : "unknown",
      targetTurnId: message.adopted_turn_id };
  }
  retryDispatch(metadata, actorId, id) {
    const scope = this.collaboration.coordinationScope(metadata, actorId), row = this.get(id);
    if (!row || row.source_session_id !== scope.logicalSessionId || row.parent_task_id !== scope.parent.id) fail("TASK_PARENT_OUTSIDE_SCOPE");
    if(row.mailbox_message_id) {
      const message=this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE message_id=?",[row.mailbox_message_id]);
      const operation=row.operation_id && this.adoptedExecution(this.store.getAgentTask(row.operation_id));
      if(!message || !operation) fail("DISPATCH_RECEIPT_NOT_FOUND","原投递记录不存在，无法恢复原指令。");
      const deliveryId=operation.deliveryId ?? operation.source?.deliveryId;
      const delivery=deliveryId && this.store.getMessageDelivery?.(deliveryId);
      const turnId=operation.targetTurnId ?? delivery?.providerTurnId ?? message.adopted_turn_id;
      if(turnId || operation.status==="completed" || message.disposition==="adopted") {
        this.update(id,{status:operation.status==="completed" ? "completed" : operation.status==="failed" ? "failed" : operation.status==="cancelled" ? "cancelled" : operation.status==="unknown" ? "unknown" : "running",error_code:null,error_message:null});
        return {...this.receipt(this.get(id)),reused:true, retryAction: operation.status === "unknown" ? "reconcile_unknown" : terminal.has(operation.status) ? "inspect_original_result" : "reuse_running", originalOperationId: operation.taskId, originalTurnId: turnId ?? null};
      }
      if(operation.status==="queued") {
        this.update(id,{status:"queued",error_code:null,error_message:null});
        this.mailbox.wake(operation.sessionId,operation.taskId);
        return {...this.receipt(this.get(id)),reused:true, retryAction:"reuse_queued", originalOperationId:operation.taskId, originalTurnId:null};
      }
      const neverAttempted=operation.source?.mailboxDispatchAttempted!==true && !delivery;
      const rejected=delivery && ["rejected","not_sent"].includes(delivery.status) && !delivery.providerTurnId;
      if(message.disposition==="pending" && ["failed","cancelled"].includes(operation.status) && (neverAttempted || rejected)) {
        this.store.updateAgentTask(operation.taskId,{status:"queued",lastError:null});
        this.update(id,{status:"queued",error_code:null,error_message:null});
        this.mailbox.wake(operation.sessionId,operation.taskId);
      } else {
        this.update(id,{status:"unknown",error_code:"DISPATCH_ACCEPTANCE_UNKNOWN",
          error_message:"原指令是否已被接收尚未确认；已保留原消息，等待现有投递恢复核对，不重复发送。"});
      }
      return {...this.receipt(this.get(id)),reused:true, retryAction:this.get(id).status === "queued" ? "requeue_unaccepted" : "reconcile_unknown", originalOperationId:operation.taskId, originalTurnId:null};
    }
    if(row.status!=="failed") return {...this.receipt(row),reused:true,retryAction:"reuse_existing",originalOperationId:row.operation_id};
    this.update(id, { status: "accepted", error_code: null, error_message: null, report_message_id: null });
    setImmediate(() => this.runDispatch(id));
    return {...this.receipt(this.get(id)),retryAction:"restart_preparation",originalOperationId:row.operation_id};
  }
  onRuntimeEvent(type, payload) {
    if(type==="TaskChanged" && payload?.entity?.id){
      this.progress.adoptManualTask(payload.entity.id);
      this.progress.scheduleTask(payload.entity.id);
    }
    if (["WorktreeIntegrationJobChanged", "GitWorktreeChanged", "WorkspaceChanged"].includes(type)) {
      for (const row of this.store.selectAll("SELECT dispatch_id FROM task_coordination_dispatches WHERE status='waiting_workspace'")) {
        setImmediate(()=>this.runDispatch(row.dispatch_id));
      }
    }
    const receivedWork = payload?.task;
    const currentWork = receivedWork?.taskId ? this.adoptedExecution(this.store.getAgentTask(receivedWork.taskId)) : null;
    // Events are notifications about stored state, not a second state authority.
    // A late started/cancelled event must not roll a newer operation back.
    const work = currentWork ?? receivedWork;
    if (currentWork && receivedWork?.status && currentWork.status !== receivedWork.status) return;
    if (currentWork?.updatedAt && receivedWork?.updatedAt && receivedWork.updatedAt < currentWork.updatedAt) return;
    if(work?.taskId && ["AgentWorkDispatchBlocked","AgentWorkDispatchReady"].includes(type)) {
      const row=this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE operation_id=?",[work.taskId]);
      if(row && !terminal.has(row.status)) {
        const reason=payload.reason ?? work.source?.dispatchBlock;
        this.update(row.dispatch_id,{status:type==="AgentWorkDispatchReady" ? "queued" : reason?.kind==="waiting" ? "waiting_dispatch" : "blocked",
          error_code:type==="AgentWorkDispatchReady" ? null : reason?.code ?? "DISPATCH_BLOCKED",
          error_message:type==="AgentWorkDispatchReady" ? null : reason?.message ?? work.lastError ?? "消息暂时无法派发。"});
        this.scheduleReports();
      }
    }
    if (work?.taskId && ["AgentWorkStarted", "AgentWorkCompleted", "AgentWorkFailed"].includes(type)) {
      const row = this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE operation_id=?", [work.taskId]);
      if (row) {
        const status = currentWork?.status ?? (type === "AgentWorkStarted" ? "running" : type === "AgentWorkFailed" ? "failed" : work.status === "cancelled" ? "cancelled" : "completed");
        this.update(row.dispatch_id, { status, error_code:type === "AgentWorkStarted" ? null : work.source?.dispatchBlock?.code ?? null,
          error_message: type === "AgentWorkStarted" ? null : work.lastError ?? null });
      }
    }
    if (["AgentWorkCompleted", "AgentWorkFailed", "SessionTurnCompleted", "SessionTurnFailed", "SessionRunCompleted", "SessionRunFailed", "SessionRunInterrupted", "TurnCompleted", "AgentTurnCompleted", "AgentTurnFailed", "MessageDeliveryChanged"].includes(type)) this.scheduleReports();
  }
  scheduleReports() {
    if (this.reportScheduled) return;
    this.reportScheduled = true;
    setImmediate(() => { this.reportScheduled = false; Promise.resolve(this.flushReports()).catch(error => console.warn(`[coordination-report] ${error.code ?? error.message}`)); });
  }
  activateShadow(taskId) {
    if (!this.shadow || this.store.getTask(taskId)?.coordination_enabled !== 1) return;
    const task = this.store.getTask(taskId), main = this.store.getLogicalSessionByLegacySessionId(task.current_session_id);
    if (!main) return;
    this.shadow.reserve(main.logicalSessionId);
    this.shadow.recover(this.mailbox, main.logicalSessionId);
    // Only unadopted queued events can move. Never replay an accepted turn.
    const queued = this.store.selectAll(`SELECT mm.message_id,mm.operation_id FROM session_mailbox_messages mm
      JOIN agent_operations op ON op.task_id=mm.operation_id
      WHERE mm.recipient_session_id=? AND mm.disposition='pending' AND op.status='queued'
        AND json_extract(mm.authorization_json,'$.purpose')='parent_report'
        AND COALESCE(json_extract(op.source_json,'$.mailboxDispatchAttempted'),0)=0`, [main.logicalSessionId]);
    this.store.runInTransaction(() => {
      for (const row of queued) {
        this.store.updateAgentTask(row.operation_id, { status: "cancelled", lastError: "Delegated to shadow Session" });
        this.store.db.run("UPDATE session_mailbox_messages SET disposition='ignored' WHERE message_id=?", [row.message_id]);
        this.store.db.run("DELETE FROM coordination_result_receipts WHERE mailbox_message_id=?", [row.message_id]);
        this.store.db.run("UPDATE task_coordination_dispatches SET report_message_id=NULL,report_generation=report_generation+1 WHERE report_message_id=?", [row.message_id]);
      }
    });
    this.store.scheduleSave();
    this.scheduleReports();
  }
  flushReports() {
    const rows = this.store.selectAll(`SELECT d.* FROM task_coordination_dispatches d
      JOIN logical_sessions l ON l.logical_session_id=d.source_session_id JOIN sessions s ON s.id=l.legacy_session_id
      WHERE d.status='completed' AND d.report_message_id IS NULL
      AND EXISTS(SELECT 1 FROM agent_operations result_op JOIN session_items result_item
        ON result_item.session_id=result_op.session_id AND result_item.turn_id=result_op.target_turn_id
        WHERE result_op.task_id=d.operation_id AND result_item.type='agentMessage'
          AND COALESCE(result_item.presentation_role,'') NOT IN ('commentary','reasoning'))
      AND s.archived=0 AND s.deleted_at IS NULL
      ORDER BY d.created_at LIMIT 100`);
    const groups = new Map();
    for (const row of rows) {
      if (this.reconcileReportedResult(row)) continue;
      const key = row.source_session_id;
      const group = groups.get(key) ?? [];
      if (group.length < 8) group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      let recipientSessionId = group[0].source_session_id;
      const logical = this.store.getLogicalSession(recipientSessionId), session = logical && this.store.getSession(logical.legacySessionId);
      const useShadow = this.shadow && (this.store.getTask(group[0].parent_task_id)?.coordination_enabled === 1 || this.shadow.forMain(recipientSessionId) || this.shadow.forShadow(recipientSessionId));
      if (!useShadow && this.shadow && (this.shadow.forMain(recipientSessionId) || this.shadow.forShadow(recipientSessionId))) continue;
      if (useShadow) {
        const delegation = this.shadow.forShadow(recipientSessionId) ?? this.shadow.forMain(recipientSessionId);
        if (!delegation?.shadow_session_id) {
          this.shadow.ensure(recipientSessionId).then(() => this.scheduleReports()).catch(error => console.warn(`[coordination-shadow] ${error.code ?? error.message}`));
          continue;
        }
        recipientSessionId = delegation.shadow_session_id;
        try { this.shadow.assertDelegate(recipientSessionId, "review_results"); } catch { continue; }
      }
      if (!session || session.archived || session.deletedAt) continue;
      if (!useShadow && (sessionHasActiveRun(session) || this.store.getRunningAgentTaskForSession(session.id)
        || this.store.listQueuedAgentTasksForSession(session.id, 100).some(op => op.source?.type !== "mailbox_event"))) continue;
      const first = group[0];
      try { for (const row of group) this.sourceContext(row); } catch { continue; }
      const results = group.map(row => {
        const work = row.operation_id ? this.store.getAgentTask(row.operation_id) : null;
        const reply = work?.targetTurnId ? this.store.selectOne(`SELECT id,binding_id,substr(text,1,1200) AS text,length(text) AS fullLength
          FROM session_items WHERE session_id=? AND turn_id=? AND type='agentMessage'
          AND COALESCE(presentation_role,'') NOT IN ('commentary','reasoning') ORDER BY created_at DESC,id DESC LIMIT 1`, [work.sessionId, work.targetTurnId]) : null;
        return { ...this.receipt(row), childSessionId: work?.sessionId ?? null, turnId: work?.targetTurnId ?? null,
          outcome: "execution_ended", targetOutcome: "not_assessed",
          finalMessageId: reply?.id ?? null, bindingId: reply?.binding_id ?? null,
          resultExcerpt: reply?.text ?? null, excerptTruncated: (reply?.fullLength ?? 0) > 1200 };
      });
      if (!results.some(result => result.finalMessageId)) continue;
      const body = `${CHILD_TASK_RESULT_NOTICE_PREFIX}本批为子会话执行结果，不是用户新指令，也不代表目标完成或已验收。一次读取本批全部结果，结合原请求判断交付、问题或后台等待；继续此前已授权的审查、集成、验证及后续待办。不要逐条确认收件、查询调度状态或向用户转述内部回执。只有实质决策或阶段成果才汇报。\n${JSON.stringify(results)}`;
      this.store.runInTransaction(() => {
        const message = this.mailbox.receiveEvent({ recipientSessionId, sourceType: "background", sourceId: first.dispatch_id,
          body, intent: "response_required", priority: 5, idempotencyKey: `report:${first.dispatch_id}:${first.report_generation}`,
          authorization: { ownerLogicalSessionId: recipientSessionId, sourceId: first.dispatch_id,
            coordinationDispatchId: first.dispatch_id, purpose: useShadow ? "shadow_report" : "parent_report", reportGeneration: first.report_generation,
            statusNotice:false } });
        for (const row of group) {
          const result = results.find(result => result.dispatchId === row.dispatch_id);
          this.recordResultReceipt(row, result, message.messageId);
          this.update(row.dispatch_id, { report_message_id: message.messageId });
          this.progress.correlateReports(row.dispatch_id,result?.finalMessageId??null);
        }
      });
    }
  }
  recordResultReceipt(row, result, mailboxMessageId, channelMessageId = null) {
    if (!result?.finalMessageId || !result.turnId || !result.childSessionId) return;
    this.store.db.run(`INSERT OR IGNORE INTO coordination_result_receipts
      (recipient_session_id,execution_session_id,turn_id,final_message_id,dispatch_id,mailbox_message_id,channel_message_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`, [row.source_session_id,result.childSessionId,result.turnId,result.finalMessageId,
      row.dispatch_id,mailboxMessageId,channelMessageId,new Date().toISOString()]);
  }
  reconcileReportedResult(row) {
    const operation = this.store.getAgentTask(row.operation_id);
    if (!operation?.targetTurnId) return false;
    const result = this.store.selectOne(`SELECT id,text FROM session_items WHERE session_id=? AND turn_id=?
      AND type='agentMessage' AND COALESCE(presentation_role,'') NOT IN ('commentary','reasoning')
      ORDER BY created_at DESC,id DESC LIMIT 1`,[operation.sessionId,operation.targetTurnId]);
    if (!result) return false;
    const receipt = this.store.selectOne(`SELECT mailbox_message_id FROM coordination_result_receipts
      WHERE recipient_session_id=? AND execution_session_id=? AND turn_id=? AND final_message_id=?`,
      [row.source_session_id,operation.sessionId,operation.targetTurnId,result.id]);
    if (receipt) {
      this.update(row.dispatch_id,{report_message_id:receipt.mailbox_message_id});
      return true;
    }
    // Only exact content from the same authenticated execution is a duplicate.
    // A question, partial update or similar wording must not hide a final result.
    const channel = this.store.selectOne(`SELECT m.message_id,mm.message_id AS mailbox_message_id
      FROM session_collaboration_messages m JOIN session_collaboration_deliveries d ON d.message_id=m.message_id
      JOIN session_mailbox_messages mm ON mm.channel_delivery_id=d.delivery_id
      WHERE m.recipient_session_id=? AND m.sender_provider_session_id=? AND m.sender_turn_id=?
      AND m.sender_operation_id=? AND m.body=? AND m.delivery_intent IN ('action_required','response_required','notification')
      AND d.status IN ('pending','queued','delivered') AND mm.disposition IN ('pending','adopted')
      ORDER BY m.created_at LIMIT 1`,[row.source_session_id,operation.sessionId,operation.targetTurnId,operation.taskId,result.text]);
    if (!channel) return false;
    this.store.runInTransaction(() => {
      this.recordResultReceipt(row,{childSessionId:operation.sessionId,turnId:operation.targetTurnId,finalMessageId:result.id},channel.mailbox_message_id,channel.message_id);
      this.update(row.dispatch_id,{report_message_id:channel.mailbox_message_id});
      this.progress.correlateReports(row.dispatch_id,result.id);
    });
    return true;
  }
  recover() {
    if (this.shadow) for (const task of this.store.selectAll("SELECT id FROM tasks WHERE coordination_enabled=1 AND archived=0 AND COALESCE(deletion_status,'')='' AND current_session_id IS NOT NULL")) this.activateShadow(task.id);
    for(const row of this.store.selectAll(`SELECT b.batch_id FROM coordination_progress_batches b
      JOIN logical_sessions l ON l.logical_session_id=b.source_session_id JOIN sessions s ON s.id=l.legacy_session_id
      WHERE s.archived=0 AND s.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 1000`)) this.progress.schedule(row.batch_id);
    for (const row of this.store.selectAll("SELECT * FROM task_coordination_dispatches WHERE status NOT IN ('completed','failed','cancelled','unknown')")) {
      if (["accepted", "preparing", "waiting_workspace"].includes(row.status)) { setImmediate(() => this.runDispatch(row.dispatch_id)); continue; }
      const work = this.store.getAgentTask(row.operation_id);
      if(["waiting_dispatch","blocked"].includes(row.status) && work?.status === "queued") continue;
      const adopted = row.mailbox_message_id && this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE message_id=? AND disposition='adopted'", [row.mailbox_message_id]);
      if (adopted) {
        const turn = this.store.getSessionTurn(adopted.adopted_provider_session_id, adopted.adopted_binding_id, adopted.adopted_turn_id);
        const status = turn?.executionStatus ?? turn?.execution_status;
        this.update(row.dispatch_id, { status: ["completed", "failed", "cancelled"].includes(status) ? status
          : ["running", "blocked"].includes(status) ? "running" : "unknown" });
      }
      else if (!work) this.update(row.dispatch_id, { status: "unknown", error_code: "DELIVERY_STATE_UNKNOWN" });
      else if (!work.targetTurnId && work.source?.mailboxDispatchAttempted) {
        if (work.status === "queued") this.store.updateAgentTask(work.taskId, { status: "cancelled", lastError: "Provider acceptance is unknown; never automatically resend." });
        this.update(row.dispatch_id, { status: "unknown", error_code: "PROVIDER_ACCEPTANCE_UNKNOWN" });
      }
      else if (["completed", "failed", "cancelled"].includes(work.status)) this.update(row.dispatch_id, { status: work.status, error_message: work.lastError ?? null });
    }
    this.scheduleReports();
  }
}
