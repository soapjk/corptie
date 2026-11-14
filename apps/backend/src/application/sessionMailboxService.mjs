import { readMailboxDispatchPage } from "../store/dispatchReadQueries.mjs";
import { redactInlineSecrets } from "../utils/providerRawMetadata.mjs";
import { boundedUnicodeText } from "../utils/unicodeText.mjs";
import { randomUUID } from "node:crypto";
import { dispatchReady, dispatchBlocked } from "../utils/dispatchDecision.mjs";
import { formatTrustedChannelMessage } from "../collaboration/trustedCollaborationEvent.mjs";

const actionable = intent => ["action_required", "response_required", "notification"].includes(intent);
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const decode = value => { try { return JSON.parse(value ?? "{}"); } catch { return {}; } };

// This is the recipient's persistent index, not another executor or scheduler.
// Source adapters retain authorization and original message ownership.
export class SessionMailboxService {
  constructor({ store, channelService, channelMailbox, wake = () => {}, changed = () => {},
    validateExternal = null, resolveActor = null, moveQueuedWork = () => {}, workEvent = () => {}, clock = () => new Date().toISOString() }) {
    Object.assign(this, { store, channelService, channelMailbox, wake, changed, validateExternal, resolveActor, moveQueuedWork, workEvent, clock });
  }

  wakeAfterCommit(...args) {
    if (this.store.afterCommit) this.store.afterCommit(() => this.wake(...args));
    else this.wake(...args);
  }

  logical(sessionId) {
    const logical = this.store.getLogicalSession(sessionId) ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) fail("MAILBOX_SESSION_NOT_FOUND", 404);
    return logical;
  }

  authorizeActor(actorId, metadata) {
    const logical = this.logical(metadata?.sessionId);
    const session = this.store.getSession(logical.legacySessionId);
    if (!actorId || (session?.agentId ?? this.resolveActor?.(logical.legacySessionId)) !== actorId || metadata.providerBindingId !== logical.activeBinding?.bindingId
      || logical.activeBinding?.state !== "active") fail("MAILBOX_SCOPE_REQUIRED", 403);
    return logical.logicalSessionId;
  }

  settings(sessionId) {
    const id = this.logical(sessionId).logicalSessionId;
    return { paused: Boolean(this.store.selectOne("SELECT paused FROM session_mailbox_settings WHERE recipient_session_id=?", [id])?.paused) };
  }

  setPaused(sessionId, paused) {
    if (typeof paused !== "boolean") fail("MAILBOX_INVALID_SETTINGS", 400);
    const logical = this.logical(sessionId);
    this.store.db.run(`INSERT INTO session_mailbox_settings(recipient_session_id,paused,updated_at) VALUES(?,?,?)
      ON CONFLICT(recipient_session_id) DO UPDATE SET paused=excluded.paused,updated_at=excluded.updated_at`,
      [logical.logicalSessionId, paused ? 1 : 0, this.clock()]);
    this.notify(logical);
    if (!paused) this.wakeAfterCommit(logical.legacySessionId);
    return this.settings(sessionId);
  }

  notify(logical) {
    this.store.scheduleSave();
    this.store.touchSessionProjectionDependency(logical.legacySessionId);
    this.changed(logical.legacySessionId);
  }

  rows(sessionId, { filter = "pending", sourceType, beforeCursor, limit = 30 } = {}) {
    const body = false;
    const logical = this.logical(sessionId);
    if (!["pending", "all", "abnormal"].includes(filter)) fail("MAILBOX_INVALID_FILTER", 400);
    const size = Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 100) fail("MAILBOX_INVALID_LIMIT", 400);
    if (beforeCursor && !/^[1-9][0-9]*$/.test(String(beforeCursor))) fail("MAILBOX_INVALID_CURSOR", 400);
    if (sourceType && !["channel", "automation", "background", "system"].includes(sourceType)) fail("MAILBOX_INVALID_SOURCE", 400);
    const where = ["mm.recipient_session_id=?"], args = [logical.logicalSessionId];
    if (sourceType) { where.push("mm.source_type=?"); args.push(sourceType); }
    if (beforeCursor) { where.push("mm.sequence < ?"); args.push(Number(beforeCursor)); }
    if (filter === "pending") where.push("mm.disposition='pending' AND COALESCE(d.status,'pending')!='delivered' AND (op.status IS NULL OR op.status='queued') AND (mm.intent IN ('action_required','response_required','notification') OR mm.manual_requested=1)");
    if (filter === "abnormal") where.push("(d.status='failed' OR b.status='unknown' OR op.status='failed' OR (op.status='cancelled' AND json_extract(op.source_json,'$.mailboxDispatchAttempted')=1))");
    const rows = this.store.selectAll(`${this.selectSql(body)} WHERE ${where.join(" AND ")} ORDER BY mm.sequence DESC LIMIT ?`, [...args, size + 1]);
    return { messages: rows.slice(0, size).map(row => this.present(row, body)), hasMore: rows.length > size,
      beforeCursor: rows.length ? String(rows[Math.min(rows.length, size) - 1].sequence) : null,
      ...this.summary(logical.logicalSessionId) };
  }

  selectSql(body) {
    return `SELECT mm.sequence,mm.message_id,mm.recipient_session_id,mm.source_type,mm.source_id,mm.intent,mm.priority,
      mm.disposition,mm.manual_requested,mm.read_at,mm.adopted_turn_id,mm.created_at, ${body ? "COALESCE(m.body,mm.body)" : "substr(COALESCE(m.body,mm.body),1,240)"} AS content,
      COALESCE(m.sender_session_id,json_extract(mm.authorization_json,'$.sourceSessionId')) AS sender_session_id,m.message_id AS original_message_id,m.created_at AS sent_at,
      d.status AS delivery_status,d.target_turn_id,b.batch_id,b.status AS batch_status,
      COALESCE(adopted.execution_status,external_turn.execution_status,op.status,cop.status) AS execution_status,
      COALESCE(mm.adopted_provider_session_id,external_delivery.session_id,op.session_id,cop.session_id) AS execution_session_id,
      COALESCE(mm.adopted_binding_id,external_delivery.binding_id) AS execution_binding_id,
      COALESCE(op.target_turn_id,cop.target_turn_id,external_delivery.provider_turn_id) AS execution_turn_id,
      json_extract(op.source_json,'$.mailboxDispatchAttempted') AS dispatch_attempted,
      json_extract(op.source_json,'$.dispatchBlock') AS dispatch_block,op.last_error AS last_error,
      (SELECT COUNT(*) FROM session_collaboration_batch_items bi WHERE bi.batch_id=b.batch_id) AS batch_count
      FROM session_mailbox_messages mm
      LEFT JOIN session_collaboration_deliveries d ON d.delivery_id=mm.channel_delivery_id
      LEFT JOIN session_collaboration_messages m ON m.message_id=d.message_id
      LEFT JOIN session_collaboration_batch_items i ON i.delivery_id=d.delivery_id
      LEFT JOIN session_collaboration_batches b ON b.batch_id=i.batch_id
      LEFT JOIN agent_operations op ON op.task_id=mm.operation_id
      LEFT JOIN agent_operations cop ON cop.task_id=b.operation_id
      LEFT JOIN session_turns adopted ON adopted.session_id=mm.adopted_provider_session_id
        AND adopted.binding_id=mm.adopted_binding_id AND adopted.turn_id=mm.adopted_turn_id
      LEFT JOIN message_deliveries external_delivery ON external_delivery.delivery_id=json_extract(op.source_json,'$.deliveryId')
      LEFT JOIN session_turns external_turn ON external_turn.session_id=external_delivery.session_id
        AND external_turn.binding_id=external_delivery.binding_id AND external_turn.turn_id=external_delivery.provider_turn_id`;
  }

  present(row, full) {
    const injected = row.disposition === "adopted" || row.delivery_status === "delivered" || Boolean(row.execution_turn_id);
    const uncertain = row.batch_status === "unknown" || (row.dispatch_attempted && !row.execution_turn_id && ["failed", "cancelled"].includes(row.execution_status));
    const state = row.disposition !== "pending" ? row.disposition : uncertain ? "unknown"
      : injected ? "injected" : row.delivery_status === "failed" || row.execution_status === "failed" ? "failed" : "pending";
    return { messageId: row.message_id, sourceType: row.source_type, sourceId: row.source_id,
      senderSessionId: row.sender_session_id ?? null, intent: row.intent, priority: row.priority,
      preview: boundedUnicodeText(row.content ?? "", 240), ...(full ? { body: row.content ?? "" } : {}),
      state, executionStatus: row.execution_status ?? null, read: Boolean(row.read_at),
      dispatchBlock: !injected && row.dispatch_block ? decode(row.dispatch_block)
        : !injected && !row.manual_requested && !actionable(row.intent) ? dispatchBlocked("MAILBOX_PASSIVE_MESSAGE","passive") : null,
      errorMessage: row.last_error && (!injected || row.execution_status === "failed") ? redactInlineSecrets(row.last_error) : null,
      manualRequested: Boolean(row.manual_requested), batchId: row.batch_id ?? null,
      batchCount: Number(row.batch_count ?? 0), turnId: row.adopted_turn_id ?? row.target_turn_id ?? row.execution_turn_id ?? null,
      canHandle: row.disposition === "pending" && !injected && !row.batch_id && (!row.execution_status || row.execution_status === "queued"),
      createdAt: row.created_at, cursor: String(row.sequence) };
  }

  get(sessionId, messageId) {
    const id = this.logical(sessionId).logicalSessionId;
    const row = this.store.selectOne(`${this.selectSql(true)} WHERE mm.message_id=? AND mm.recipient_session_id=?`, [messageId, id]);
    if (!row) fail("MAILBOX_MESSAGE_NOT_FOUND", 404);
    const message = this.present(row, true);
    // Detail-only indexed lookup. Listing the mailbox never loads Turn items.
    const processingItem = message.turnId && row.execution_session_id
      ? this.store.selectOne(`SELECT id FROM session_items WHERE session_id=? AND turn_id=?
        AND (? IS NULL OR binding_id=?) AND type NOT IN ('userMessage','automationEvent')
        ORDER BY created_at,id LIMIT 1`, [row.execution_session_id, message.turnId,
          row.execution_binding_id, row.execution_binding_id]) : null;
    return { ...message, processingSessionId: processingItem ? row.execution_session_id : null,
      processingItemId: processingItem?.id ?? null };
  }

  raw(sessionId, messageId) {
    const id = this.logical(sessionId).logicalSessionId;
    const row = this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE recipient_session_id=? AND message_id=?", [id, messageId]);
    if (!row) fail("MAILBOX_MESSAGE_NOT_FOUND", 404);
    return row;
  }

  summary(sessionId) {
    const id = this.logical(sessionId).logicalSessionId;
    const result = this.store.selectOne(`SELECT
      SUM(CASE WHEN mm.disposition='pending' AND (mm.intent IN ('action_required','response_required','notification') OR mm.manual_requested=1)
        AND COALESCE(d.status,'pending') IN ('pending','queued') AND (op.status IS NULL OR op.status='queued') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN mm.read_at IS NULL THEN 1 ELSE 0 END) AS unread
      FROM session_mailbox_messages mm LEFT JOIN session_collaboration_deliveries d ON d.delivery_id=mm.channel_delivery_id
      LEFT JOIN agent_operations op ON op.task_id=mm.operation_id WHERE mm.recipient_session_id=?`, [id]);
    return { pendingCount: Number(result?.pending ?? 0), unreadCount: Number(result?.unread ?? 0), ...this.settings(id) };
  }

  mutate(sessionId, messageId, action) {
    const logical = this.logical(sessionId);
    let ignoredWork = null;
    this.store.runInTransaction(() => {
      const row = this.raw(sessionId, messageId);
      const message = this.get(sessionId, messageId);
      if (action !== "read" && !message.canHandle) fail("MAILBOX_MESSAGE_ALREADY_CLAIMED");
      if (action === "read") this.store.db.run("UPDATE session_mailbox_messages SET read_at=?,updated_at=? WHERE message_id=?", [this.clock(), this.clock(), messageId]);
      else if (action === "process") {
        this.validate(row);
        if (!row.operation_id && !row.channel_delivery_id) {
          const operation = this.store.enqueueAgentTask({ taskId: `mailbox-work:${messageId}`,
            agentId: this.store.getSession(logical.legacySessionId).agentId ?? this.resolveActor?.(logical.legacySessionId), sessionId: logical.legacySessionId,
            kind: "user", priority: 50, text: row.body,
            source: { type: "mailbox_event", mailboxMessageId: messageId, deliveryId: messageId }, createdAt: this.clock() });
          this.store.db.run("UPDATE session_mailbox_messages SET operation_id=? WHERE message_id=?", [operation.taskId, messageId]);
        }
        const queuedWork = row.operation_id ? this.store.getAgentTask(row.operation_id)
          : row.channel_delivery_id ? this.store.getAgentTaskForDelivery(row.channel_delivery_id) : this.store.getAgentTask(`mailbox-work:${messageId}`);
        if (queuedWork?.status === "queued") this.store.db.run("UPDATE agent_operations SET priority=90,updated_at=? WHERE task_id=?", [this.clock(), queuedWork.taskId]);
        this.store.db.run("UPDATE session_mailbox_messages SET manual_requested=1,priority=90,updated_at=? WHERE message_id=?", [this.clock(), messageId]);
      } else if (action === "ignore") {
        this.store.db.run("UPDATE session_mailbox_messages SET disposition='ignored',updated_at=? WHERE message_id=?", [this.clock(), messageId]);
        ignoredWork = this.cancelQueued(row, "ignored");
      } else fail("MAILBOX_INVALID_ACTION", 400);
    });
    this.notify(logical);
    if (ignoredWork?.source?.type === "scheduled_session_task") this.workEvent("AgentWorkCompleted", ignoredWork);
    if (action === "process") this.wakeAfterCommit(logical.legacySessionId);
    return this.get(sessionId, messageId);
  }

  validate(row) {
    const logical = this.logical(row.recipient_session_id);
    if (!logical.activeBinding || logical.activeBinding.state !== "active") fail("MAILBOX_ROUTE_UNAVAILABLE");
    if (row.channel_delivery_id) return this.channelService.resolveDeliveryRoute(row.channel_delivery_id);
    const authorization = decode(row.authorization_json);
    if (this.validateExternal) return this.validateExternal(row, authorization);
    if (row.source_type === "automation") fail("MAILBOX_SOURCE_AUTHORIZATION_UNAVAILABLE", 503);
    if (authorization.ownerLogicalSessionId !== row.recipient_session_id || authorization.sourceId !== row.source_id) {
      fail("MAILBOX_EVENT_SCOPE_REQUIRED", 403);
    }
  }

  cancelQueued(row, reason) {
    const work = row.operation_id ? this.store.getAgentTask(row.operation_id)
      : row.channel_delivery_id ? this.store.getAgentTaskForDelivery(row.channel_delivery_id) : null;
    if (work?.status === "queued") {
      const cancelled = this.store.updateAgentTask(work.taskId, { status: "cancelled", cancellation: { actor: "mailbox", reason },
        source: { ...work.source, mailboxDisposition: reason } });
      return cancelled;
    }
  }

  canRetarget(row) {
    if (!row || row.disposition !== "pending" || row.adopted_turn_id) return false;
    if (row.channel_delivery_id && this.store.selectOne("SELECT 1 FROM session_collaboration_batch_items WHERE delivery_id=?", [row.channel_delivery_id])) return false;
    const work = row.operation_id ? this.store.getAgentTask(row.operation_id)
      : row.channel_delivery_id ? this.store.getAgentTaskForDelivery(row.channel_delivery_id) : null;
    if (!work || work.targetTurnId || work.startedAt || work.source?.mailboxDispatchAttempted || work.source?.deleted) return false;
    const receipt = work.deliveryId && this.store.getMessageDelivery(work.deliveryId);
    if (receipt) return false;
    const previous = this.store.selectOne("SELECT deleted_at FROM sessions WHERE id=?", [work.sessionId]);
    // Store deletion cancels queued operations. Only a provably unstarted
    // operation on a deleted Session may be resumed here; user cancellation isn't.
    return work.status === "queued" || work.status === "cancelled" && Boolean(previous?.deleted_at)
      && !work.executionEvidence?.cancellation;
  }

  retargetUnstarted(messageId, recipientSessionId, authorization) {
    const logical = this.logical(recipientSessionId);
    if (logical.deletedAt || logical.archived || logical.activeBinding?.state !== "active") fail("MAILBOX_ROUTE_UNAVAILABLE");
    let previousId, previousSessionId, operation;
    this.store.runInTransaction(() => {
      const row = this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE message_id=?", [messageId]);
      if (!this.canRetarget(row)) return;
      previousId = row.recipient_session_id;
      const auth = { ...decode(row.authorization_json), ...authorization, ownerLogicalSessionId: logical.logicalSessionId };
      operation = row.operation_id ? this.store.getAgentTask(row.operation_id) : this.store.getAgentTaskForDelivery(row.channel_delivery_id);
      previousSessionId = operation.sessionId;
      if (previousId === logical.logicalSessionId && operation.sessionId === logical.legacySessionId
        && JSON.stringify(auth) === row.authorization_json && operation.status === "queued") { operation = null; return; }
      this.store.db.run("UPDATE session_mailbox_messages SET recipient_session_id=?,authorization_json=?,updated_at=? WHERE message_id=?",
        [logical.logicalSessionId, JSON.stringify(auth), this.clock(), messageId]);
      operation = this.store.updateAgentTask(operation.taskId, { sessionId: logical.legacySessionId,
        status: "queued", lastError: null, completedAt: null,
        source: { ...operation.source, coordinationPurpose: auth.purpose, dispatchBlock: null } });
    });
    if (operation) {
      if (previousSessionId !== operation.sessionId) this.moveQueuedWork(previousSessionId, operation.sessionId, operation.taskId);
      this.notify(logical);
      const previous = this.store.getLogicalSession(previousId);
      if (previous && previousId !== logical.logicalSessionId) this.notify(previous);
      this.wakeAfterCommit(logical.legacySessionId, operation.taskId);
    }
    return Boolean(operation);
  }

  adopt(sessionId, messageIds) {
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 8 || new Set(messageIds).size !== messageIds.length) fail("MAILBOX_INVALID_SELECTION", 400);
    const logical = this.logical(sessionId);
    const active = this.store.listUnsettledSessionTurns(logical.legacySessionId)
      .filter(row => row.binding_id === logical.activeBinding?.bindingId);
    if (active.length !== 1) fail("MAILBOX_ACTIVE_TURN_REQUIRED");
    const turnId = active[0].turn_id;
    const messages = [], startedWork = [];
    this.store.runInTransaction(() => {
      for (const messageId of messageIds) {
        const row = this.raw(sessionId, messageId);
        const message = this.get(sessionId, messageId);
        if (row.disposition === "adopted" && row.adopted_turn_id === turnId) { messages.push(message); continue; }
        if (!message.canHandle) fail("MAILBOX_MESSAGE_ALREADY_CLAIMED");
        if (this.settings(sessionId).paused && !row.manual_requested) fail("MAILBOX_PAUSED");
        this.validate(row);
        messages.push({ ...message, ...(row.channel_delivery_id ? { trustedContent: formatTrustedChannelMessage(this.channelService.getDeliveryEnvelope(row.channel_delivery_id)) } : {}) });
      }
      if (Buffer.byteLength(JSON.stringify(messages), "utf8") > 64 * 1024) fail("MAILBOX_INPUT_BUDGET_EXCEEDED", 413);
      for (const messageId of messageIds) {
        const row = this.raw(sessionId, messageId);
        if (row.disposition === "adopted" && row.adopted_turn_id === turnId) continue;
        this.cancelQueued(row, "adopted");
        this.store.db.run(`UPDATE session_mailbox_messages SET disposition='adopted',adopted_turn_id=?,adopted_binding_id=?,adopted_provider_session_id=?,read_at=?,updated_at=? WHERE message_id=?`,
          [turnId, logical.activeBinding.bindingId, logical.legacySessionId, this.clock(), this.clock(), messageId]);
        if (row.channel_delivery_id) this.channelService.updateDelivery(row.channel_delivery_id, {
          status: "delivered", deliveredAt: this.clock(), targetTurnId: turnId });
        if ((row.source_type === "automation" || decode(row.authorization_json).coordinationDispatchId) && row.operation_id) {
          const work = decode(row.authorization_json).coordinationDispatchId
            ? this.store.updateAgentTask(row.operation_id, { targetTurnId: turnId })
            : this.store.getAgentTask(row.operation_id);
          startedWork.push({ ...work, status: "running", targetTurnId: turnId });
        }
      }
    });
    this.notify(logical);
    for (const work of startedWork) this.workEvent("AgentWorkStarted", work);
    return { turnId, messages, note: "Messages adopted by this turn. Do not submit them again." };
  }

  canDispatchOperation(operation) {
    return this.dispatchDecision(operation).allowed;
  }

  reportDispatchBlock() {
    // Dispatch telemetry already lives on the original operation. It is not
    // a question or a result and must never create a parent mailbox operation.
  }

  dispatchDecision(operation) {
    if (this.channelService?.resolveDelegatedRecipient && operation.source?.type === "session_channel" && operation.deliveryId) {
      const message = this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE channel_delivery_id=?", [operation.deliveryId]);
      if (message && this.canRetarget(message)) {
        try {
          const route = this.channelService.resolveDeliveryRoute(operation.deliveryId);
          if (route.sessionId !== message.recipient_session_id) this.retargetUnstarted(message.message_id, route.sessionId, {});
        } catch (error) { return dispatchBlocked(error.code ?? "MAILBOX_ROUTE_UNAVAILABLE", "waiting"); }
      }
    }
    this.reconcileCoordination?.(operation);
    const current = this.store.getAgentTask(operation.taskId);
    if (current && current.sessionId !== operation.sessionId) return dispatchBlocked("MAILBOX_ROUTE_CHANGED", "waiting");
    const row = operation.source?.mailboxMessageId ? this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE message_id=?", [operation.source.mailboxMessageId])
      : operation.source?.type === "session_channel" ? this.store.selectOne("SELECT * FROM session_mailbox_messages WHERE channel_delivery_id=?", [operation.deliveryId]) : null;
    if (!row) return operation.source?.mailboxMessageId ? dispatchBlocked("MAILBOX_MESSAGE_NOT_FOUND","rejected") : dispatchReady();
    if (row.disposition !== "pending") return dispatchBlocked(row.disposition === "ignored" ? "MAILBOX_MESSAGE_IGNORED" : "MAILBOX_MESSAGE_ADOPTED","settled");
    let logical;
    try { logical=this.logical(row.recipient_session_id); }
    catch { return dispatchBlocked("RECIPIENT_SESSION_NOT_FOUND","blocked"); }
    const session = this.store.getSession(logical.legacySessionId);
    if (!session) return dispatchBlocked("RECIPIENT_SESSION_NOT_FOUND","blocked");
    if (session.deletedAt || logical.deletedAt) return dispatchBlocked("RECIPIENT_SESSION_DELETED","blocked");
    if (session.archived || logical.archived) return dispatchBlocked("RECIPIENT_SESSION_ARCHIVED","blocked");
    if (logical.activeBinding?.state !== "active") return dispatchBlocked("MAILBOX_ROUTE_UNAVAILABLE","blocked");
    // Cancelled describes a previous run, never the disposition of new mail.
    if (row.manual_requested) return dispatchReady();
    if (this.settings(logical.logicalSessionId).paused) return dispatchBlocked("MAILBOX_PAUSED","paused");
    return actionable(row.intent) ? dispatchReady() : dispatchBlocked("MAILBOX_PASSIVE_MESSAGE","passive");
  }

  validateOperation(operation) {
    if (!operation.source?.mailboxMessageId) return;
    const row = this.raw(operation.sessionId, operation.source.mailboxMessageId);
    this.validate(row);
  }

  enqueueExternalOperation(input, { sourceType = "automation", authorization = {}, intent = "action_required" } = {}) {
    const logical = this.logical(input.sessionId);
    const messageId = `mailbox:${input.taskId}`;
    let result;
    this.store.runInTransaction(() => {
      result = this.store.enqueueAgentTaskWithResult({ ...input,
        source: { ...input.source, deliveryId: input.source?.deliveryId ?? messageId, mailboxMessageId: messageId } });
      if (!result.task.source.mailboxMessageId) result.task = this.store.updateAgentTask(result.task.taskId, {
        source: { ...result.task.source, mailboxMessageId: messageId }
      });
      this.store.db.run(`INSERT OR IGNORE INTO session_mailbox_messages
        (message_id,recipient_session_id,source_type,source_id,operation_id,body,intent,priority,authorization_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [messageId, logical.logicalSessionId, sourceType,
        input.source?.scheduledTaskId ?? authorization.sourceId ?? input.taskId, result.task.taskId,
        input.text, intent, input.priority, JSON.stringify(authorization), input.createdAt ?? this.clock(), this.clock()]);
    });
    this.notify(logical);
    return result;
  }

  receiveEvent({ recipientSessionId, sourceType, sourceId, body, authorization, intent = "notification", priority = 50, idempotencyKey }) {
    if (!["background", "system"].includes(sourceType) || !["notification", "acknowledgement", "action_required", "response_required"].includes(intent)
      || typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > 60 * 1024 || !idempotencyKey
      || !Number.isInteger(priority) || priority < 0 || priority > 100) fail("MAILBOX_INVALID_EVENT", 400);
    const logical = this.logical(recipientSessionId);
    if (authorization?.ownerLogicalSessionId !== logical.logicalSessionId || authorization?.sourceId !== sourceId) fail("MAILBOX_EVENT_SCOPE_REQUIRED", 403);
    const existing = this.store.selectOne("SELECT message_id FROM session_mailbox_messages WHERE source_type=? AND source_id=? AND recipient_session_id=? AND json_extract(authorization_json,'$.idempotencyKey')=?",
      [sourceType, sourceId, logical.logicalSessionId, idempotencyKey]);
    if (existing) {
      const message = this.get(logical.logicalSessionId, existing.message_id);
      if (message.body !== body || message.intent !== intent) fail("MAILBOX_IDEMPOTENCY_CONFLICT");
      return message;
    }
    if (actionable(intent)) {
      const session = this.store.getSession(logical.legacySessionId);
      const id = `mailbox-event:${randomUUID()}`;
      const result = this.enqueueExternalOperation({ taskId: id, sessionId: session.id, agentId: session.agentId ?? this.resolveActor?.(session.id),
        kind: "user", priority, text: body, source: { type: "mailbox_event", sourceType, sourceId,
          ...(authorization.coordinationDispatchId ? { coordinationDispatchId: authorization.coordinationDispatchId } : {}),
          ...(authorization.purpose ? { coordinationPurpose: authorization.purpose } : {}) }, createdAt: this.clock() },
        { sourceType, intent, authorization: { ...authorization, idempotencyKey } });
      this.wakeAfterCommit(logical.legacySessionId, result.task.taskId);
      return this.get(logical.logicalSessionId, `mailbox:${id}`);
    }
    const messageId = `mailbox:${randomUUID()}`;
    this.store.db.run(`INSERT INTO session_mailbox_messages
      (message_id,recipient_session_id,source_type,source_id,body,intent,authorization_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, [messageId, logical.logicalSessionId, sourceType, sourceId, body, intent,
      JSON.stringify({ ...authorization, idempotencyKey }), this.clock(), this.clock()]);
    // Acknowledgements settle as receipts; they never schedule an ACK-to-ACK turn.
    this.store.db.run("UPDATE session_mailbox_messages SET disposition='adopted',read_at=?,updated_at=? WHERE message_id=?",[this.clock(),this.clock(),messageId]);
    this.notify(logical);
    return this.get(logical.logicalSessionId, messageId);
  }

  importQueuedAutomations() {
    const rows = this.store.selectAll(`SELECT task_id FROM agent_operations WHERE status IN ('queued','running')
      AND json_extract(source_json,'$.type')='scheduled_session_task'
      AND json_extract(source_json,'$.mailboxMessageId') IS NULL`);
    for (const row of rows) {
      const work = this.store.getAgentTask(row.task_id);
      this.enqueueExternalOperation(work, { sourceType: "automation", authorization: { sourceId: work.source.scheduledTaskId } });
    }
  }

  async syncQueuedOperations(register) {
    const page = this.store.getBackgroundReadPool
      ? await this.store.getBackgroundReadPool().readMailboxDispatchPage({ after: this.queueSyncCursor ?? 0, limit: 500 })
      : readMailboxDispatchPage(this.store.db, { after: this.queueSyncCursor ?? 0, limit: 500 });
    this.queueSyncCursor = page.nextCursor;
    const rows = page.rows;
    for (const row of rows) {
      const operation = this.store.getAgentTask(row.operation_id);
      // The read snapshot may be stale by the time its response arrives.
      if (!operation || operation.status !== "queued") continue;
      const current = this.store.selectOne("SELECT disposition,recipient_session_id FROM session_mailbox_messages WHERE operation_id=?", [row.operation_id]);
      if (current?.disposition !== "pending" || current.recipient_session_id !== row.recipient_session_id) continue;
      let logical;
      try { logical=this.logical(row.recipient_session_id); }
      catch { register(operation.sessionId,operation.taskId); continue; }
      if (operation.sessionId !== logical.legacySessionId) this.store.updateAgentTask(operation.taskId, { sessionId: logical.legacySessionId });
      register(logical.legacySessionId, operation.taskId);
    }
  }

  settleAdopted(sessionId, turnId, status) {
    const logical = this.store.getLogicalSession(sessionId) ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) return;
    const rows = this.store.selectAll(`SELECT operation_id FROM session_mailbox_messages
      WHERE recipient_session_id=? AND adopted_turn_id=? AND (source_type='automation'
        OR json_extract(authorization_json,'$.coordinationDispatchId') IS NOT NULL)`, [logical.logicalSessionId, turnId]);
    if (!rows.length) return;
    for (const row of rows) {
      const work = this.store.getAgentTask(row.operation_id);
      const settled = work && this.store.updateAgentTask(work.taskId, { status, targetTurnId: turnId });
      if (settled) this.workEvent(status === "failed" ? "AgentWorkFailed" : "AgentWorkCompleted", settled);
    }
    this.notify(logical);
  }
}
