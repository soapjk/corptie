import { coordinationDelegation } from "../domain/coordinationDelegation.mjs";
import { randomUUID } from "node:crypto";

const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
export const SHADOW_SCOPE = Object.freeze(["read_children", "dispatch_children", "review_results", "deliver_children", "reclaim_children", "publish_reports"]);

// This service owns the delegation, not execution. Provider lifecycle, mailbox
// admission and running turns stay with their existing Session services.
export class ShadowSessionService {
  constructor({ store, createSession, deleteSession = null, recoverSession = null, recoveryDelaysMs = [1000, 5000, 15000], emitEvent = () => {} }) {
    Object.assign(this, { store, createSession, deleteSession, recoverSession, recoveryDelaysMs, emitEvent });
    this.creating = new Map();
    this.recovering = new Map();
    this.retryTimers = new Map(); this.retryAttempts = new Map();
  }
  forMain(id) { return this.store.selectOne("SELECT * FROM coordination_shadow_sessions WHERE main_session_id=?", [id]); }
  forShadow(id) { return this.store.selectOne("SELECT * FROM coordination_shadow_sessions WHERE shadow_session_id=?", [id]); }
  // History lookup never implies that a delegation is live or that mode is on.
  inspect(mainId) {
    let owner;
    try { owner = this.owner(mainId); } catch (error) { return { status: "unavailable", mainId, reason: error.code }; }
    const row = this.forMain(mainId);
    if (owner.task.coordination_enabled !== 1) return { status: "ready", role: "parent", mainId, sessionId: mainId, row };
    if (!row?.shadow_session_id) return { status: "recovering", mainId, row, reason: "SHADOW_SESSION_MISSING" };
    const logical = this.store.getLogicalSession(row.shadow_session_id);
    const session = logical && this.store.getSession(logical.legacySessionId);
    if (!session || session.deletedAt || logical.deletedAt) return { status: "recovering", mainId, row, reason: "SHADOW_SESSION_DELETED" };
    if (session.archived || logical.archived) return { status: "recovering", mainId, row, reason: "SHADOW_SESSION_ARCHIVED" };
    if (logical.activeBinding?.state !== "active") return { status: "recovering", mainId, row, reason: "SHADOW_BINDING_UNAVAILABLE" };
    try { this.assertDelegate(row.shadow_session_id); }
    catch (error) { return { status: "unavailable", mainId, row, reason: error.code }; }
    return { status: "ready", role: "summary-shadow", mainId, sessionId: row.shadow_session_id, row };
  }
  resolveRecipient(mainId) { return this.inspect(mainId); }
  changed(mainId) {
    const row = this.forMain(mainId);
    if (row) this.emitEvent("TaskChanged", { taskId: row.parent_task_id, action: "coordination-state" });
  }
  requestRecovery(mainId, { force = false } = {}) {
    if (this.recovering.has(mainId)) return this.recovering.get(mainId);
    if (force) {
      clearTimeout(this.retryTimers.get(mainId)); this.retryTimers.delete(mainId); this.retryAttempts.delete(mainId);
      this.retryAfterLifecycleChange(mainId);
    }
    // A failed configuration is retried on a lifecycle change or explicit retry,
    // not for every unrelated Provider event.
    const current = this.inspect(mainId);
    if (!force && current.row?.last_error && current.row.state === "failed") return Promise.resolve(null);
    const flight = this.ensure(mainId).then(row => {
      this.retryAttempts.delete(mainId);
      this.onRecovered?.(mainId);
      return row;
    }).catch(error => {
      this.store.db.run("UPDATE coordination_shadow_sessions SET state='failed',last_error=?,updated_at=? WHERE main_session_id=?",
        [String(error.code ?? error.message).slice(0, 1000), new Date().toISOString(), mainId]);
      this.store.scheduleSave(); this.changed(mainId);
      const attempt = this.retryAttempts.get(mainId) ?? 0;
      if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|RATE_LIMIT|PROVIDER_TIMEOUT/.test(String(error.code)) && attempt < this.recoveryDelaysMs.length) {
        this.retryAttempts.set(mainId, attempt + 1);
        const timer = setTimeout(() => {
          this.retryTimers.delete(mainId);
          this.retryAfterLifecycleChange(mainId);
          void this.requestRecovery(mainId);
        }, this.recoveryDelaysMs[attempt]);
        timer.unref?.(); this.retryTimers.set(mainId, timer);
      }
      return null;
    }).finally(() => { this.recovering.delete(mainId); this.changed(mainId); });
    this.recovering.set(mainId, flight);
    return flight;
  }
  dispose() { for (const timer of this.retryTimers.values()) clearTimeout(timer); this.retryTimers.clear(); }
  admit(mainId, turnId, body, source, mailbox) {
    this.reserve(mainId);
    const requestId = `shadow-request:${randomUUID()}`;
    this.store.db.run(`INSERT OR IGNORE INTO coordination_shadow_requests
      (request_id,main_session_id,source_turn_id,body,source_json,created_at) VALUES(?,?,?,?,?,?)`,
      [requestId, mainId, turnId, body, JSON.stringify(source ?? {}), new Date().toISOString()]);
    this.store.scheduleSave();
    const row = this.store.selectOne("SELECT * FROM coordination_shadow_requests WHERE main_session_id=? AND source_turn_id=?", [mainId, turnId]);
    setImmediate(() => this.deliverRequest(row.request_id, mailbox).catch(error => console.warn(`[shadow-request] ${error.code ?? error.message}`)));
    return { requestId: row.request_id, status: row.mailbox_message_id ? "queued" : "accepted" };
  }
  async deliverRequest(requestId, mailbox) {
    const row = this.store.selectOne("SELECT * FROM coordination_shadow_requests WHERE request_id=?", [requestId]);
    if (!row) return;
    if (row.mailbox_message_id) { this.reconcileMailbox(mailbox, row.main_session_id); return; }
    const target = await this.readyRecipient(row.main_session_id);
    this.store.runInTransaction(() => {
      const message = mailbox.receiveEvent({ recipientSessionId: target.sessionId, sourceType: "background", sourceId: requestId,
        intent: "response_required", priority: 50, idempotencyKey: requestId, body: row.body,
        authorization: { ownerLogicalSessionId: target.sessionId, sourceId: requestId,
          purpose: "shadow_request", shadowRequestId: requestId, sourceSessionId: row.main_session_id, sourceTurnId: row.source_turn_id } });
      this.store.db.run("UPDATE coordination_shadow_requests SET mailbox_message_id=? WHERE request_id=?", [message.messageId, requestId]);
    });
    this.store.scheduleSave();
  }
  validateRequest(row, authorization) {
    const request = this.store.selectOne("SELECT * FROM coordination_shadow_requests WHERE request_id=?", [authorization.shadowRequestId]);
    if (!request || request.request_id !== row.source_id) fail("SHADOW_REQUEST_SCOPE_INVALID");
    this.assertRecipient(row, request.main_session_id);
  }
  assertRecipient(row, mainId) {
    const target = this.resolveRecipient(mainId);
    if (target.status !== "ready" || target.sessionId !== row.recipient_session_id) fail("SHADOW_RECIPIENT_CHANGED");
  }
  reconcileMailbox(mailbox, mainId) {
    const { task } = this.owner(mainId);
    const target = this.resolveRecipient(mainId);
    const rows = this.store.selectAll(`SELECT mm.* FROM session_mailbox_messages mm
      JOIN logical_sessions l ON l.logical_session_id=mm.recipient_session_id
      JOIN sessions s ON s.id=l.legacy_session_id
      JOIN agent_operations op ON op.task_id=mm.operation_id
      WHERE s.task_id=? AND mm.disposition='pending' AND mm.channel_delivery_id IS NULL
      AND mm.adopted_turn_id IS NULL AND op.target_turn_id IS NULL AND op.started_at IS NULL
      AND COALESCE(json_extract(op.source_json,'$.mailboxDispatchAttempted'),0)=0
      AND (op.status='queued' OR (op.status='cancelled' AND s.deleted_at IS NOT NULL AND json_extract(op.execution_evidence_json,'$.cancellation') IS NULL))
      AND json_extract(mm.authorization_json,'$.purpose') IN
        ('shadow_request','shadow_requirement','shadow_report','parent_report','shadow_decision','shadow_delivery_blocked')
      AND mm.recipient_session_id<>? ORDER BY mm.sequence LIMIT 100`, [task.id, target.sessionId ?? ""]);
    if (!rows.length) return;
    if (target.status !== "ready") { if (target.status === "recovering") void this.requestRecovery(mainId); return; }
    let moved = 0;
    for (const row of rows) {
      const auth = JSON.parse(row.authorization_json);
      if (["shadow_report", "parent_report"].includes(auth.purpose)) auth.purpose = target.role === "parent" ? "parent_report" : "shadow_report";
      if (mailbox.retargetUnstarted(row.message_id, target.sessionId, auth)) moved++;
    }
    if (rows.length === 100 && moved) setImmediate(() => {
      try { this.reconcileMailbox(mailbox, mainId); }
      catch (error) { console.warn(`[shadow-mailbox-recovery] ${error.code ?? error.message}`); }
    });
  }
  recover(mailbox, mainId = null) {
    if (mainId) this.reconcileMailbox(mailbox, mainId);
    void this.recoverRequests(mailbox, mainId).catch(error => console.warn(`[shadow-request] ${error.code ?? error.message}`));
  }
  async recoverRequests(mailbox, mainId, cursor = null) {
    const rows = this.store.selectAll(`SELECT request_id,created_at FROM coordination_shadow_requests
      WHERE mailbox_message_id IS NULL AND (? IS NULL OR main_session_id=?)
      ${cursor ? "AND (created_at>? OR (created_at=? AND request_id>?))" : ""}
      ORDER BY created_at,request_id LIMIT 100`, [mainId, mainId, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.request_id] : [])]);
    const results = await Promise.allSettled(rows.map(row => this.deliverRequest(row.request_id, mailbox)));
    for (const result of results) if (result.status === "rejected") console.warn(`[shadow-request] ${result.reason.code ?? result.reason.message}`);
    if (rows.length === 100) {
      await new Promise(resolve => setImmediate(resolve));
      await this.recoverRequests(mailbox, mainId, rows.at(-1));
    }
  }
  retryAfterLifecycleChange(mainId) {
    const row = this.forMain(mainId);
    if (row?.state !== "failed") return;
    this.store.db.run("UPDATE coordination_shadow_sessions SET state=?,last_error=NULL WHERE main_session_id=?",
      [row.shadow_session_id ? "ready" : "pending", mainId]);
    this.store.scheduleSave();
  }
  summary(mainId) {
    const row = this.forMain(mainId);
    if (!row) return null;
    const route = row.shadow_session_id && this.store.getLogicalSession(row.shadow_session_id);
    const session = route && this.store.getSession(route.legacySessionId);
    const task = this.store.getTask(row.parent_task_id);
    const reports = this.store.selectAll(`SELECT report_id AS id,substr(body,1,1200) AS text,created_at AS createdAt
      FROM coordination_shadow_reports WHERE main_session_id=? ORDER BY created_at DESC,report_id DESC LIMIT 3`, [mainId]);
    const pendingDecisions = this.store.selectOne(`SELECT COUNT(*) AS count FROM coordination_shadow_reports
      WHERE main_session_id=? AND decision_json IS NOT NULL AND json_extract(decision_json,'$.answerMessageId') IS NULL`, [mainId]).count;
    const target = this.inspect(mainId);
    const status = task?.coordination_enabled !== 1 ? "off" : this.creating.has(mainId) || this.recovering.has(mainId) ? "recovering"
      : target.status !== "ready" || row.last_error ? "failed" : ["running", "blocked"].includes(session?.status) ? "running" : "idle";
    return { sessionId: target.status === "ready" && target.role === "summary-shadow" ? row.shadow_session_id : null, status,
      recoveryReason: status === "failed" ? row.last_error ?? target.reason : null, canRecover: status === "failed" && target.status !== "unavailable",
      lastReportAt: reports[0]?.createdAt ?? null, pendingDecisions, reports };
  }
  owner(mainId) {
    const logical = this.store.getLogicalSession(mainId);
    const session = logical && this.store.getSession(logical.legacySessionId);
    const task = session?.taskId && this.store.getTask(session.taskId);
    if (!session || session.archived || session.deletedAt || logical.archived || logical.deletedAt || logical.activeBinding?.state !== "active"
      || !task || task.archived || task.deletion_status || task.current_session_id !== session.id) fail("SHADOW_OWNER_UNAVAILABLE");
    return { logical, session, task };
  }
  reserve(mainId) {
    const { task } = this.owner(mainId), now = new Date().toISOString();
    this.store.db.run(`INSERT OR IGNORE INTO coordination_shadow_sessions
      (main_session_id,parent_task_id,scope_json,created_at,updated_at) VALUES(?,?,?,?,?)`,
      [mainId, task.id, JSON.stringify(SHADOW_SCOPE), now, now]);
    const row = this.forMain(mainId);
    if (row.parent_task_id !== task.id) fail("SHADOW_OWNER_CHANGED");
    this.store.scheduleSave();
    return row;
  }
  ensure(mainId) {
    if (this.creating.has(mainId)) return this.creating.get(mainId);
    const flight = this.create(mainId).finally(() => { this.creating.delete(mainId); this.changed(mainId); });
    this.creating.set(mainId, flight);
    return flight;
  }
  async create(mainId) {
    const initial = this.owner(mainId);
    if (initial.task.coordination_enabled !== 1) return this.forMain(mainId);
    let row = this.reserve(mainId);
    const current = this.inspect(mainId);
    if (current.status === "ready") return row;
    if (current.status === "unavailable") fail(current.reason);
    let created;
    try {
      if (current.reason === "SHADOW_BINDING_UNAVAILABLE" && this.recoverSession) {
        await this.recoverSession(row.shadow_session_id);
        if (this.inspect(mainId).status === "ready") return this.forMain(mainId);
        fail("SHADOW_BINDING_UNAVAILABLE");
      }
      if (current.reason === "SHADOW_BINDING_UNAVAILABLE") fail(current.reason);
      const oldId = row.shadow_session_id;
      this.store.db.run(`UPDATE coordination_shadow_sessions SET shadow_session_id=NULL,state='pending',last_error=NULL,updated_at=?
        WHERE main_session_id=? AND shadow_session_id IS ?`, [new Date().toISOString(), mainId, oldId]);
      this.store.scheduleSave(); this.changed(mainId);
      const { session, logical, task } = this.owner(mainId);
      if (task.coordination_enabled !== 1) return this.forMain(mainId);
      created = await this.createSession(logical.activeBinding.providerId, {
        title: this.title(mainId), cwd: session.external?.cwd,
        model: session.external?.currentModel, reasoningLevel: session.external?.currentReasoningLevel,
        sessionKind: "worker"
      }, { source: "coordination-shadow", shadowOwnerSessionId: mainId,
        actorId: session.agentId, workId: task.work_id, taskId: task.id });
      const shadowId = this.store.getLogicalSessionByLegacySessionId(created.id)?.logicalSessionId;
      if (!shadowId) fail("SHADOW_BINDING_UNAVAILABLE");
      const latest = this.owner(mainId);
      if (latest.task.coordination_enabled !== 1 || latest.logical.activeBinding.bindingId !== logical.activeBinding.bindingId) {
        await this.deleteSession?.(created.id); created = null;
        this.store.db.run("UPDATE coordination_shadow_sessions SET shadow_session_id=NULL,state='pending',last_error=NULL WHERE main_session_id=? AND shadow_session_id=?", [mainId, shadowId]);
        this.store.scheduleSave();
        this.changed(mainId); return this.forMain(mainId);
      }
      this.store.db.run(`UPDATE coordination_shadow_sessions SET shadow_session_id=?,state='ready',last_error=NULL,updated_at=?
        WHERE main_session_id=? AND shadow_session_id IS NULL`, [shadowId, new Date().toISOString(), mainId]);
      row = this.forMain(mainId);
      if (row.shadow_session_id !== shadowId) { await this.deleteSession?.(created.id); created = null; }
      this.assertDelegate(row.shadow_session_id);
      this.store.scheduleSave(); this.changed(mainId);
      return row;
    } catch (error) {
      if (created) {
        const createdId = this.store.getLogicalSessionByLegacySessionId(created.id)?.logicalSessionId;
        try {
          await this.deleteSession?.(created.id);
          this.store.db.run("UPDATE coordination_shadow_sessions SET shadow_session_id=NULL WHERE main_session_id=? AND shadow_session_id=?", [mainId, createdId]);
        } catch { /* The recorded binding keeps cleanup recoverable. */ }
      }
      this.store.db.run("UPDATE coordination_shadow_sessions SET state='failed',last_error=?,updated_at=? WHERE main_session_id=?",
        [String(error.code ?? error.message).slice(0, 1000), new Date().toISOString(), mainId]);
      this.store.scheduleSave(); this.changed(mainId);
      throw error;
    }
  }
  async readyRecipient(mainId) {
    let result = this.resolveRecipient(mainId);
    if (result.status === "recovering") { await this.ensure(mainId); result = this.resolveRecipient(mainId); }
    if (result.status !== "ready") fail(result.reason ?? "SHADOW_SESSION_PREPARING");
    return result;
  }
  // Archived executors retain their names; replacement gets its own name.
  title(mainId) { return `影子会话_${mainId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${randomUUID().slice(0, 8)}`; }
  channelRecipient(envelope) {
    const mainId = envelope.message.recipientSessionId;
    const route = this.store.getLogicalSession(mainId), main = route && this.store.getSession(route.legacySessionId);
    const parent = main?.taskId && this.store.getTask(main.taskId);
    const senderRoute = this.store.getLogicalSession(envelope.message.senderSessionId);
    const sender = senderRoute && this.store.getSession(senderRoute.legacySessionId);
    const child = sender?.taskId && this.store.getTask(sender.taskId);
    if (!parent || parent.current_session_id !== main.id || child?.parent_task_id !== parent.id || child.work_id !== parent.work_id) return null;
    const target = this.resolveRecipient(mainId);
    if (target.status === "ready") return target.role === "parent" ? null : target.sessionId;
    if (target.status === "recovering") {
      void this.requestRecovery(mainId);
      fail("SHADOW_SESSION_PREPARING");
    }
    fail(target.reason ?? "SHADOW_SESSION_PREPARING");
  }

  assertDelegate(shadowId, capability = null) {
    const row = this.forShadow(shadowId);
    if (!row || row.state !== "ready") fail("SHADOW_DELEGATION_UNAVAILABLE");
    const { task, session: main } = this.owner(row.main_session_id);
    const logical = this.store.getLogicalSession(shadowId), session = logical && this.store.getSession(logical.legacySessionId);
    if (!coordinationDelegation(this.store, shadowId) || !session || logical.archived || session.archived || session.deletedAt || logical.activeBinding?.state !== "active"
      || session.taskId !== task.id || session.workId !== task.work_id || session.agentId !== main.agentId
      || capability && !JSON.parse(row.scope_json).includes(capability)) fail("SHADOW_DELEGATION_INVALID");
    return row;
  }
  revise(mainId) {
    this.reserve(mainId);
    this.store.db.run("UPDATE coordination_shadow_sessions SET requirement_revision=requirement_revision+1,updated_at=? WHERE main_session_id=?",
      [new Date().toISOString(), mainId]);
    this.store.scheduleSave();
    return this.forMain(mainId).requirement_revision;
  }
  async deliver({ shadowId, taskId, reportId, evidence }) {
    const delegation = this.assertDelegate(shadowId, "deliver_children"), child = this.store.getTask(taskId);
    if (!child || child.parent_task_id !== delegation.parent_task_id) fail("SHADOW_CHILD_OUTSIDE_SCOPE");
    const report = this.store.selectOne("SELECT * FROM coordination_shadow_reports WHERE report_id=? AND shadow_session_id=?", [reportId, shadowId]);
    if (!report || report.requirement_revision !== delegation.requirement_revision) fail("SHADOW_REQUIREMENT_CHANGED");
    if (!Array.isArray(evidence) || !evidence.length || evidence.length > 20) fail("SHADOW_REVIEW_EVIDENCE_REQUIRED");
    for (const id of evidence) {
      const found = this.store.selectOne(`SELECT i.id FROM session_items i JOIN sessions s ON s.id=i.session_id
        WHERE i.id=? AND s.task_id=? AND i.type='agentMessage' AND COALESCE(i.presentation_role,'') NOT IN ('commentary','reasoning')`, [id, taskId]);
      if (!found) fail("SHADOW_REVIEW_EVIDENCE_INVALID");
    }
    const now = new Date().toISOString();
    const latestDispatchId = this.store.selectOne("SELECT dispatch_id FROM task_coordination_dispatches WHERE target_task_id=? ORDER BY created_at DESC,dispatch_id DESC LIMIT 1", [taskId])?.dispatch_id ?? null;
    this.store.db.run(`INSERT INTO coordination_shadow_reclamation
      (task_id,main_session_id,shadow_session_id,report_id,phase,recovery_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET report_id=excluded.report_id,recovery_json=excluded.recovery_json,updated_at=excluded.updated_at
      WHERE coordination_shadow_reclamation.phase='delivery' AND NOT EXISTS
        (SELECT 1 FROM child_task_delivery_operations d WHERE d.child_task_id=excluded.task_id AND d.state IN ('queued','running','waiting'))`,
      [taskId, delegation.main_session_id, shadowId, reportId, "delivery", JSON.stringify({ evidence, latestDispatchId }), now, now]);
    this.store.scheduleSave();
    if (!this.deliverChild) fail("SHADOW_DELIVERY_UNAVAILABLE");
    return this.deliverChild(taskId);
  }
  async answer(mainId, reportId, body, sourceTurnId, mailbox) {
    this.owner(mainId);
    const report = this.store.selectOne("SELECT * FROM coordination_shadow_reports WHERE report_id=? AND main_session_id=?", [reportId, mainId]);
    const question = report?.decision_json && JSON.parse(report.decision_json);
    if (!question?.question) fail("SHADOW_DECISION_NOT_FOUND");
    const target = await this.readyRecipient(mainId);
    if (question.answerMessageId) return { messageId: question.answerMessageId, reused: true };
    let message;
    this.store.runInTransaction(() => {
      message = mailbox.receiveEvent({ recipientSessionId: target.sessionId, sourceType: "background", sourceId: reportId,
        intent: "response_required", priority: 50, idempotencyKey: `shadow-decision:${reportId}`,
        body: `主会话收到用户对待决策事项的答复。按当前需求继续处理，不向主会话确认收件。\n问题：${question.question}\n答复：${body}`,
        authorization: { ownerLogicalSessionId: target.sessionId, sourceId: reportId,
          purpose: "shadow_decision", mainSessionId: mainId, sourceTurnId, shadowReportId: reportId } });
      this.store.db.run("UPDATE coordination_shadow_reports SET decision_json=? WHERE report_id=?",
        [JSON.stringify({ ...question, answerMessageId: message.messageId, answerSourceTurnId: sourceTurnId }), reportId]);
    });
    return message;
  }
  validateDecision(row, authorization) {
    const report = this.store.selectOne("SELECT * FROM coordination_shadow_reports WHERE report_id=?", [authorization.shadowReportId]);
    if (!report || row.source_id !== report.report_id) fail("SHADOW_DECISION_SCOPE_INVALID");
    this.assertRecipient(row, report.main_session_id);
  }
  async deliveryBlocked(operation, mailbox) {
    const review = this.store.selectOne("SELECT * FROM coordination_shadow_reclamation WHERE task_id=?", [operation.taskId]);
    if (!review || review.shadow_session_id !== operation.actor.id) fail("SHADOW_DELIVERY_EVENT_INVALID");
    const target = await this.readyRecipient(review.main_session_id);
    return mailbox.receiveEvent({ recipientSessionId: target.sessionId, sourceType: "background", sourceId: operation.operationId,
      intent: "response_required", priority: 5, idempotencyKey: `delivery-blocked:${operation.operationId}:${operation.errorCode}`,
      body: `子任务交付需要处理。请核对原因并派发修复或向用户集中提问，不重复发送原派发。\n${JSON.stringify({ taskId: operation.taskId, operationId: operation.operationId, phase: operation.phase, errorCode: operation.errorCode })}`,
      authorization: { ownerLogicalSessionId: target.sessionId, sourceId: operation.operationId,
        purpose: "shadow_delivery_blocked", shadowDeliveryId: operation.operationId } });
  }
  validateDeliveryEvent(row, authorization) {
    const operation = this.store.selectOne("SELECT * FROM child_task_delivery_operations WHERE operation_id=?", [authorization.shadowDeliveryId]);
    const review = operation && this.store.selectOne("SELECT * FROM coordination_shadow_reclamation WHERE task_id=?", [operation.child_task_id]);
    if (!review || row.source_id !== operation.operation_id || JSON.parse(operation.actor_json).id !== review.shadow_session_id) fail("SHADOW_DELIVERY_EVENT_INVALID");
    this.assertRecipient(row, review.main_session_id);
  }
  publish({ shadowId, turnId, revision, body, decision = null }) {
    const row = this.assertDelegate(shadowId, "publish_reports");
    const old = this.store.selectOne("SELECT * FROM coordination_shadow_reports WHERE shadow_session_id=? AND source_turn_id=?", [shadowId, turnId]);
    if (old) return old;
    // A report derived from an older requirement must never replace current
    // user intent or claim the newer request has been completed.
    if (revision !== row.requirement_revision) fail("SHADOW_REQUIREMENT_CHANGED");
    if (typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > 32 * 1024) fail("SHADOW_REPORT_INVALID");
    const reportId = `shadow-report:${randomUUID()}`, createdAt = new Date().toISOString();
    const { logical: main } = this.owner(row.main_session_id);
    const item = { id: reportId, turnId: reportId, bindingId: main.activeBinding.bindingId,
      type: "agentMessage", presentationRole: "final_answer", text: `**后台汇总**\n\n${body}`, status: "completed", turnStatus: "completed", createdAt,
      rawMetadataJSON: JSON.stringify({ executionMode: "shadow_report", sourceSessionId: shadowId, sourceTurnId: turnId, decision }) };
    this.store.runInTransaction(() => {
      this.store.db.run(`INSERT INTO coordination_shadow_reports
        (report_id,main_session_id,shadow_session_id,source_turn_id,requirement_revision,body,decision_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
        [reportId, row.main_session_id, shadowId, turnId, revision, body, decision ? JSON.stringify(decision) : null, createdAt]);
      this.store.upsertTimelineItemProjection(main.legacySessionId, item);
      this.store.db.run("UPDATE coordination_shadow_sessions SET processed_revision=?,updated_at=? WHERE main_session_id=?", [revision, createdAt, row.main_session_id]);
    });
    this.store.scheduleSave();
    // Projection only: no mailbox event, Provider send, main turn or main status.
    this.emitEvent("SessionCoordinationMilestone", { turnId: reportId, item, hasAgentMessage: true }, { sessionId: main.legacySessionId });
    return this.store.selectOne("SELECT * FROM coordination_shadow_reports WHERE report_id=?", [reportId]);
  }
}
