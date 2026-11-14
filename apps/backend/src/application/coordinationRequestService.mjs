import { coordinationDelegation } from "../domain/coordinationDelegation.mjs";
import { randomUUID } from "node:crypto";
import { BackgroundOperationQueue } from "./backgroundOperationQueue.mjs";

const terminal = new Set(["completed", "failed", "cancelled"]);
const fault = (code, message = code) => Object.assign(new Error(message), { code, statusCode: 409 });
const now = () => new Date().toISOString();
const measured = async (requestId, phase, operation) => {
  const started = performance.now();
  try { return await operation(); }
  finally { console.info("[coordination-request-performance]", JSON.stringify({ requestId, phase, elapsedMs: Math.round(performance.now() - started) })); }
};

// Main-message admission and temporary Session execution have separate lifetimes.
// This is a projection over existing Delivery/Session/dispatch authorities, not a mailbox.
export class CoordinationRequestService {
  constructor({ store, turns, createSession, deleteSession, resolveReference, buildContext = async () => null, resolveMessage = async (_reference, message) => message, emitEvent = () => {}, concurrency = 4, forgetQueued = () => {} }) {
    Object.assign(this, { store, turns, createSession, deleteSession, resolveReference, buildContext, resolveMessage, emitEvent, forgetQueued });
    this.queue = new BackgroundOperationQueue({ concurrency, maxPending: 64, perOwnerLimit: Math.max(2, concurrency - 1) });
    this.running = new Map();
    this.preparing = new Map();
    this.previews = new Map();
    this.reclaiming = new Map();
    this.cleanupRetries = new Map();
  }
  get(id) { return this.store.selectOne("SELECT * FROM coordination_requests WHERE request_id=?", [id]); }
  forShadow(id) { return this.store.selectOne("SELECT * FROM coordination_requests WHERE shadow_session_id=?", [id]); }
  accepts(reference, source = {}) {
    return !this.forShadow(reference.logicalSessionId) && !this.turns.dispatch.shadow?.forShadow(reference.logicalSessionId)
      && this.turns.taskFor(reference)?.coordination_enabled === 1
      && !["mailbox_event", "session_channel", "automation", "background"].includes(source.type);
  }
  owner(row) {
    const reference = this.resolveReference(row.main_session_id), task = this.turns.taskFor(reference);
    if (!task || task.id !== row.parent_task_id || task.current_session_id !== reference.sessionId
      || task.archived || task.deletion_status) throw fault("REQUEST_OWNER_UNAVAILABLE");
    return reference;
  }
  update(id, values) {
    const entries = Object.entries({ ...values, updated_at: now() });
    this.store.db.run(`UPDATE coordination_requests SET ${entries.map(([k]) => `${k}=?`).join(",")} WHERE request_id=?`, [...entries.map(([, v]) => v), id]);
    this.store.scheduleSave();
  }
  admit(reference, message, source, delivery, operation) {
    const messageId = source.messageId ?? delivery?.messageId ?? randomUUID();
    const previous = this.store.selectOne("SELECT * FROM coordination_requests WHERE main_session_id=? AND message_id=?", [reference.logicalSessionId, messageId]);
    if (previous) {
      if (operation) this.store.updateAgentTask(operation.taskId, { status: "completed", lastError: null });
      this.schedule(previous.request_id); return previous;
    }
    const id = `request:${randomUUID()}`, timestamp = now();
    this.store.runInTransaction(() => {
      this.store.db.run(`INSERT INTO coordination_requests
        (request_id,main_session_id,parent_task_id,message_id,delivery_id,operation_id,message_json,source_json,config_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [id, reference.logicalSessionId, this.turns.taskFor(reference).id,
        messageId, delivery?.deliveryId ?? source.deliveryId ?? null, operation?.taskId ?? null,
        JSON.stringify(message), JSON.stringify(source), JSON.stringify({ providerId: reference.providerId,
          model: this.store.getSession(reference.sessionId).external?.currentModel ?? null,
          reasoningLevel: this.store.getSession(reference.sessionId).external?.currentReasoningLevel ?? null }), timestamp, timestamp]);
      // Transport work has handed off to a durable independent request; it must
      // not keep the main Session's ordinary work queue occupied.
      if (operation) this.store.updateAgentTask(operation.taskId, { status: "completed", lastError: null });
    });
    this.store.scheduleSave();
    const deliveryId = delivery?.deliveryId ?? source.deliveryId;
    if (deliveryId && this.store.getMessageDelivery(deliveryId)) this.store.updateMessageDelivery(deliveryId, { status: "processing" });
    this.publishStatus(id);
    this.schedule(id);
    return this.get(id);
  }
  migrateQueued(mainId) {
    const reference = this.resolveReference(mainId);
    if (!this.accepts(reference, { type: "desktop" })) return;
    for (const operation of this.store.listQueuedAgentTasksForSession(reference.sessionId, 100)) {
      const source = operation.source ?? {};
      if (operation.kind !== "user" || !["desktop", "remote-client", "feishu"].includes(source.type)) continue;
      this.admit(reference, source.messageContent ?? { text: operation.text, images: [] }, source,
        source.deliveryId && this.store.getMessageDelivery(source.deliveryId), operation);
      this.forgetQueued(reference.sessionId, operation.taskId);
    }
  }
  index(mainId, exclude = null, { activeOnly = false, offset = 0, limit = 20 } = {}) {
    return this.store.selectAll(`SELECT request_id AS requestId,message_id AS messageId,status,relation,
      related_request_id AS relatedRequestId,response_item_id AS responseItemId,dispatch_json AS dispatches,
      error_code AS errorCode,error_message AS errorMessage,cleanup_error AS cleanupError,phase,
      substr(json_extract(message_json,'$.text'),1,800) AS question FROM coordination_requests
      WHERE main_session_id=? AND request_id<>COALESCE(?,'') ${activeOnly ? "AND (status NOT IN ('completed','cancelled') OR cleanup_error IS NOT NULL)" : ""}
      ORDER BY CASE WHEN status IN ('accepted','preparing','running','waiting') THEN 0 ELSE 1 END,created_at DESC LIMIT ? OFFSET ?`, [mainId, exclude, Math.min(100,limit), Math.max(0,offset)]);
  }
  schedule(id) {
    const row = this.get(id);
    if (!row || terminal.has(row.status) || row.status === "waiting" || this.running.has(id)) return;
    const controller = new AbortController(), queuedAt = performance.now();
    this.preparing.set(id, controller);
    const flight = this.queue.run(() => {
      console.info("[coordination-request-performance]", JSON.stringify({ requestId: id, phase: "queue", elapsedMs: Math.round(performance.now() - queuedAt) }));
      return this.run(id, controller.signal);
    }, { priority: 1, signal: controller.signal, owner: row.main_session_id }).catch(error => this.finish(id, "failed", error))
      .finally(() => {
        this.running.delete(id); this.preparing.delete(id); this.wakeDependents(id);
        const current = this.get(id);
        if (current && terminal.has(current.status)) void this.reclaim(current);
        else if (current?.status === "accepted") this.schedule(id);
        else if (current?.status === "waiting") this.wakeDependents(current.dependency_id);
      });
    this.running.set(id, flight);
  }
  async run(id, signal) {
    let row = this.get(id);
    if (!row || terminal.has(row.status)) return;
    const main = this.owner(row), session = this.store.getSession(main.sessionId);
    this.update(id, { status: "preparing" }); this.publishStatus(id);
    if (!row.context_json) {
      // Canonical product history includes replies projected by other shadows.
      // Keep a bounded window with an explicit cursor; older pages remain readable.
      const sharedContext = await measured(id, "context", () => this.buildContext(main, JSON.parse(row.message_json), JSON.parse(row.source_json)));
      signal?.throwIfAborted();
      const items = []; let before = null, hasMore = false, bytes = 0, exhausted = false, pages = 0;
      // History is bounded at admission, so unrelated later inputs cannot become instructions.
      const boundary = row.created_at;
      before = { createdAt: boundary, id: "\uffff" };
      do {
        pages++;
        const page = this.store.readContextConversationPage(main.sessionId, { limit: 20, before });
        hasMore = page.hasMore; before = page.nextCursor;
        for (const item of page.items) {
          if (item.createdAt > boundary) continue;
          const text = item.text ?? "";
          if (bytes + Buffer.byteLength(text) > 32000) { hasMore = true; exhausted = true; before = items.at(-1)?.cursor ?? null; break; }
          bytes += Buffer.byteLength(text);
          items.push({ id: item.id, role: item.type, text, truncated: Boolean(item.textTruncated), cursor: { id: item.id, createdAt: item.createdAt } });
        }
        if (exhausted || bytes >= 26000 || items.length >= 100) break;
      } while (hasMore && before && items.length < 100 && pages < 10);
      const instructions = sharedContext?.prompt ?? null;
      this.update(id, { context_json: JSON.stringify({ instructions, messages: items.reverse(), historyTruncated: hasMore }),
        context_cursor: JSON.stringify({ version: 1, boundary, older: before, hasMore }) });
    }
    signal?.throwIfAborted();

    if (!row.shadow_session_id) {
      const config = JSON.parse(row.config_json);
      await measured(id, "session-create", () => this.createSession(config.providerId, { title: `请求影子_${id.split(":")[1]}`, sessionKind: "worker",
        cwd: session.external?.cwd, model: config.model, reasoningLevel: config.reasoningLevel },
      { source: "coordination-request", requestId: id, shadowOwnerSessionId: row.main_session_id,
        actorId: session.agentId, workId: session.workId, taskId: session.taskId, signal }));
    }
    row = this.get(id);
    if (terminal.has(row.status)) { await this.reclaim(row); return; }
    if (!row.shadow_session_id) throw fault("REQUEST_BINDING_UNAVAILABLE");
    const reference = this.resolveReference(row.shadow_session_id);
    this.update(id, { status: "running", attempt: row.attempt + 1 }); this.publishStatus(id);
    await this.turns.send(reference, await this.resolveMessage(main, JSON.parse(row.message_json)), {
      idempotencyKey: `${row.request_id}:${row.attempt + 1}`, source: JSON.parse(row.source_json), requestId: id
    });
    row = this.get(id);

  }
  dependency(id) {
    const row = this.get(id);
    if (!row) return null;
    const result = row.response_item_id && this.store.selectOne("SELECT text FROM session_items WHERE id=?", [row.response_item_id]);
    return { requestId: id, status: row.status, responseItemId: row.response_item_id, result: result?.text ?? null, errorCode: row.error_code, dispatches: this.dispatches(row) };
  }
  dispatches(row) {
    return row?.shadow_session_id ? this.store.selectAll("SELECT dispatch_id AS dispatchId,target_task_id AS taskId,status FROM task_coordination_dispatches WHERE executor_session_id=?", [row.shadow_session_id]) : [];
  }
  supplementPending(target) {
    return !terminal.has(target.status) || this.dispatches(target).some(item => !item.taskId && !["failed", "cancelled", "unknown"].includes(item.status));
  }
  assertDelegate(id) {
    const row = this.forShadow(id);
    if (!row || terminal.has(row.status)) throw fault("REQUEST_RETIRED");
    const delegation = coordinationDelegation(this.store, id);
    if (!delegation) throw fault("REQUEST_SCOPE_INVALID");
    const main = this.owner(row), reference = this.resolveReference(id);
    const a = this.store.getSession(main.sessionId), b = this.store.getSession(reference.sessionId);
    if (!b || b.taskId !== a.taskId || b.workId !== a.workId || b.agentId !== a.agentId) throw fault("REQUEST_SCOPE_INVALID");
    return row;
  }
  relate(id, relation, targetId) {
    const row = this.get(id), target = this.get(targetId);
    if (!target || target.main_session_id !== row.main_session_id || target.created_at > row.created_at || targetId === id)
      throw fault("REQUEST_RELATION_INVALID");
    if (!["supplement", "depends_on", "cancel"].includes(relation)) throw fault("REQUEST_RELATION_INVALID");
    let cursor = target;
    const seen = new Set([id]);
    while (cursor) {
      if (seen.has(cursor.request_id)) throw fault("REQUEST_DEPENDENCY_CYCLE");
      seen.add(cursor.request_id);
      cursor = cursor.dependency_id ? this.get(cursor.dependency_id) : null;
    }
    this.update(id, { relation, related_request_id: targetId, dependency_id: ["depends_on", "supplement"].includes(relation) ? targetId : null });
    if (relation === "cancel") return this.cancel(row.main_session_id, targetId);
    if (relation === "depends_on" && !terminal.has(target.status) || relation === "supplement" && this.supplementPending(target)) { this.update(id, { status: "waiting" }); return { waiting: true }; }
    return { waiting: false, target };
  }
  async retry(mainId, id) {
    const row = this.get(id);
    if (!row || row.main_session_id !== mainId) throw fault("REQUEST_NOT_FOUND");
    this.owner(row);
    if (row.status !== "failed") return row;
    if (row.phase === "admitting" || row.dispatch_json) throw fault("REQUEST_OUTCOME_UNCERTAIN", "请先核对已受理派发的结果，不能重复执行。");
    await this.reclaim(row);
    if (this.get(id).cleanup_error) throw fault("REQUEST_CLEANUP_PENDING", this.get(id).cleanup_error);
    const delivery = row.delivery_id && this.store.getMessageDelivery(row.delivery_id);
    const operation = row.operation_id && this.store.getAgentTask(row.operation_id);
    const source = row.source_json ? JSON.parse(row.source_json) : operation?.source ?? {};
    const message = row.message_json ? JSON.parse(row.message_json) : source.messageContent ?? { text: delivery?.text ?? "" };
    if (!message.text && !message.images?.length) throw fault("REQUEST_INPUT_UNAVAILABLE");
    // An explicit retry starts a fresh execution while retaining original input identity.
    this.update(id, { status: "accepted", phase: "reading", shadow_session_id: null,
      message_json: JSON.stringify(message), source_json: JSON.stringify(source), error_code: null, error_message: null });
    if (row.delivery_id && this.store.getMessageDelivery(row.delivery_id)) {
      this.store.updateMessageDelivery(row.delivery_id, { status: "processing", lastError: null });
      this.emitEvent("MessageDeliveryChanged", { delivery: this.store.getMessageDelivery(row.delivery_id) }, { sessionId: this.owner(row).sessionId });
    }
    this.publishStatus(id); this.schedule(id); return this.get(id);
  }
  async cancel(mainId, id) {
    const row = this.get(id);
    if (!row || row.main_session_id !== mainId) throw fault("REQUEST_NOT_FOUND");
    if (terminal.has(row.status)) return row;
    if (this.running.has(id) || row.shadow_session_id) this.update(id, { cleanup_error: "资源清理中" });
    this.finish(id, "cancelled");
    this.preparing.get(id)?.abort(fault("REQUEST_CANCELLED"));
    if (row.shadow_session_id) {
      try { await this.turns.interrupt(this.resolveReference(row.shadow_session_id)); } catch { /* Late creation is reclaimed by its owning flight. */ }
    }
    if (!this.running.has(id)) await this.reclaim(this.get(id));
    return this.get(id);
  }
  async cancelForMain(mainId) {
    const rows = this.store.selectAll("SELECT request_id FROM coordination_requests WHERE main_session_id=? AND status NOT IN ('completed','failed','cancelled')", [mainId]);
    await Promise.all(rows.map(row => this.cancel(mainId, row.request_id)));
  }
  preview(id, text) {
    // Only display a declared conversational reply; never expose raw planner JSON.
    if (!/"kind"\s*:\s*"(?:discussion|clarification)"/.test(text)) return;
    const match = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
    if (!match) return;
    let body;
    try { body = JSON.parse('"' + match[1] + '"'); } catch { return; }
    const previous = this.previews.get(id);
    if (!body || previous?.text === body || previous && Date.now() - previous.time < 120) return;
    const row = this.get(id);
    if (!row || terminal.has(row.status)) return;
    const main = this.owner(row), createdAt = previous?.createdAt ?? now();
    this.previews.set(id, { text: body, time: Date.now(), createdAt });
    const item = { id: `${id}:reply`, turnId: id, bindingId: main.bindingId, type: "agentMessage",
      presentationRole: "final_answer", text: body, status: "inProgress", turnStatus: "running", createdAt,
      rawMetadataJSON: JSON.stringify({ executionMode: "coordination-request", requestId: id,
        replyToMessageId: row.message_id, sourceSessionId: row.shadow_session_id }) };
    this.store.upsertTimelineItemProjection(main.sessionId, item);
    this.emitEvent("SessionCoordinationMilestone", { item, turnId: id }, { sessionId: main.sessionId });
  }
  publish(id, item, dispatches = null) {
    const row = this.get(id);
    if (!row || terminal.has(row.status)) return;
    const main = this.owner(row), itemId = `${id}:reply`;
    const projected = { ...item, createdAt: this.previews.get(id)?.createdAt ?? item.createdAt, id: itemId, turnId: id, bindingId: main.bindingId,
      rawMetadataJSON: JSON.stringify({ executionMode: "coordination-request", requestId: id,
        replyToMessageId: row.message_id, sourceSessionId: row.shadow_session_id }) };
    this.store.runInTransaction(() => {
      this.store.upsertTimelineItemProjection(main.sessionId, projected);
      this.update(id, { response_item_id: itemId, dispatch_json: JSON.stringify(this.store.selectAll("SELECT dispatch_id AS dispatchId,target_task_id AS taskId,status FROM task_coordination_dispatches WHERE executor_session_id=?", [row.shadow_session_id])) });
    });
    this.emitEvent("SessionCoordinationCompleted", { turnId: id, item: projected, hasAgentMessage: true }, { sessionId: main.sessionId });
    this.finish(id, "completed");
  }
  finish(id, status, error = null) {
    const row = this.get(id);
    if (!row || terminal.has(row.status)) return;
    this.update(id, { status, error_code: error?.code ?? null, error_message: error?.message ?? null });
    if (row.delivery_id && this.store.getMessageDelivery(row.delivery_id)) {
      this.store.updateMessageDelivery(row.delivery_id, { status: status === "completed" ? "completed" : status,
        lastError: error?.message ?? null });
      const main = this.store.getLogicalSession(row.main_session_id);
      this.emitEvent("MessageDeliveryChanged", { delivery: this.store.getMessageDelivery(row.delivery_id) }, { sessionId: main?.legacySessionId });
    }
    const savedPreview = !this.previews.has(id) && this.store.selectOne(
      "SELECT text,created_at AS createdAt FROM session_items WHERE id=? AND status='inProgress'", [`${id}:reply`]);
    const partial = this.previews.get(id) ?? savedPreview;
    if (partial && status !== "completed") {
      const main = this.store.getLogicalSession(row.main_session_id);
      if (main) {
        const item = { id: `${id}:reply`, turnId: id, type: "agentMessage", text: partial.text,
          status, turnStatus: status, createdAt: partial.createdAt,
          rawMetadataJSON: JSON.stringify({ requestId: id, replyToMessageId: row.message_id, sourceSessionId: row.shadow_session_id }) };
        this.store.upsertTimelineItemProjection(main.legacySessionId, item);
        this.emitEvent("SessionCoordinationCompleted", { turnId: id, item }, { sessionId: main.legacySessionId });
      }
    }
    this.previews.delete(id);
    this.publishStatus(id); this.wakeDependents(id);
  }
  publishStatus(id) {
    const row = this.get(id);
    if (!row) return;
    let main; try { main = this.resolveReference(row.main_session_id); } catch { return; }
    this.emitEvent("TaskChanged", { taskId: row.parent_task_id, action: "coordination-request" });
    this.emitEvent("SessionCoordinationRequestChanged", { requestId: id, messageId: row.message_id,
      status: row.status, errorCode: row.error_code, errorMessage: row.error_message }, { sessionId: main.sessionId });
  }
  wakeDependents(id) {
    if (!terminal.has(this.get(id)?.status)) return;
    for (const row of this.store.selectAll("SELECT request_id,relation FROM coordination_requests WHERE dependency_id=? AND status='waiting'", [id])) {
      if (row.relation === "supplement" && this.supplementPending(this.get(id))) continue;
      this.update(row.request_id, { status: "accepted" }); this.schedule(row.request_id);
    }
  }
  reclaim(row) {
    if (this.reclaiming.has(row.request_id)) return this.reclaiming.get(row.request_id);
    const flight = measured(row.request_id, "cleanup", () => this.reclaimSession(row)).finally(() => {
      this.reclaiming.delete(row.request_id); this.publishStatus(row.request_id);
    });
    this.reclaiming.set(row.request_id, flight); return flight;
  }
  async reclaimSession(row) {
    if (!row.shadow_session_id) {
      this.update(row.request_id, { context_json: null, cleanup_error: null, ...(row.status === "failed" ? {} : { message_json: null, source_json: null }) });
      return;
    }
    try {
      const logical = this.store.getLogicalSession(row.shadow_session_id);
      if (logical?.activeBinding?.state === "active") await this.deleteSession(row.shadow_session_id);
      const ids = [...new Set([row.shadow_session_id, logical?.legacySessionId].filter(Boolean))];
      if (this.store.getCoordinationCleanupPool) {
        for (const sessionId of ids) await this.store.getCoordinationCleanupPool().reclaimSessionRows(sessionId);
      }
      this.store.runInTransaction(() => {
        for (const sessionId of ids) {
          if (!this.store.getCoordinationCleanupPool) for (const table of ["session_items", "session_events", "session_logs", "provider_event_inbox", "event_outbox", "message_deliveries", "session_turns", "session_execution_plan_state", "session_memory_topics", "memory_extraction_progress", "memory_backfill_progress", "memory_extraction_jobs"])
            this.store.db.run(`DELETE FROM ${table} WHERE session_id=?`, [sessionId]);
          if (!this.store.getCoordinationCleanupPool) this.store.db.run("DELETE FROM session_context_references WHERE owner_session_id=?", [sessionId]);
          this.store.db.run("UPDATE agent_operations SET text='',source_json='{}',execution_evidence_json=NULL,last_error=NULL WHERE session_id=?", [sessionId]);
          this.store.db.run("UPDATE logical_sessions SET session_name='',session_name_key=NULL WHERE logical_session_id=?", [sessionId]);
          this.store.db.run("UPDATE sessions SET title='',summary='',raw_json='{}' WHERE id=?", [sessionId]);
        }
        this.update(row.request_id, { message_json: row.status === "failed" ? row.message_json : null, source_json: row.status === "failed" ? row.source_json : null, context_json: null, cleanup_error: null });
      });
    } catch (error) {
      this.update(row.request_id, { cleanup_error: String(error.code ?? error.message) });
      if (!this.cleanupRetries.has(row.request_id)) {
        const timer = setTimeout(() => {
          this.cleanupRetries.delete(row.request_id);
          if (this.store.db) { const current = this.get(row.request_id); if (current && terminal.has(current.status)) void this.reclaim(current); }
        }, 30_000);
        timer.unref?.(); this.cleanupRetries.set(row.request_id, timer);
      }
    }
  }
  recover() {
    for (const row of this.store.selectAll("SELECT * FROM coordination_requests ORDER BY created_at")) {
      if (terminal.has(row.status)) { if (row.context_json || row.message_json) void this.reclaim(row); continue; }
      if (row.response_item_id) { this.finish(row.request_id, "completed"); void this.reclaim(this.get(row.request_id)); continue; }
      if (row.status === "waiting") { this.wakeDependents(row.dependency_id); continue; }
      if (row.phase === "admitting") { this.finish(row.request_id, "failed", fault("REQUEST_OUTCOME_UNCERTAIN", "已尝试派发；请核对原派发记录，不会自动重复执行。")); continue; }
      if (row.shadow_session_id) {
        const route = this.store.getLogicalSession(row.shadow_session_id);
        if (route?.activeBinding) {
          for (const turn of this.store.listUnsettledSessionTurns(route.legacySessionId)) this.store.upsertSessionTurn({
            sessionId: route.legacySessionId, bindingId: turn.binding_id, routingVersion: route.routingVersion,
            turnId: turn.turn_id, executionStatus: "cancelled", startedAt: turn.started_at, endedAt: now(),
            failure: { code: "REQUEST_READ_INTERRUPTED", message: "恢复只读请求阶段" } });
        }
      }
      // Only replay a read/decision phase. Committed actions are never replayed.
      this.update(row.request_id, { status: "accepted" }); this.schedule(row.request_id);
    }
  }
}
