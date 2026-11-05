import { randomUUID } from "node:crypto";
import { formatTrustedChannelBatch } from "./trustedCollaborationEvent.mjs";

const SILENT = new Set(["acknowledgement"]);
export const CHANNEL_BATCH_MAX_BYTES = 64 * 1024;

// Persistent membership belongs to the mailbox; execution still belongs to the
// existing Session operation queue. No semantic classification or model calls.
export class SessionChannelMailboxService {
  constructor({ store, sessionChannelService, sessionMailbox = null, clock = () => Date.now(), maxMessages = 8,
    maxBytes = CHANNEL_BATCH_MAX_BYTES, quietMs = 2000, maxWaitMs = 5000, enabled = true }) {
    Object.assign(this, { store, service: sessionChannelService, sessionMailbox, clock,
      maxMessages: enabled ? maxMessages : 1, maxBytes,
      quietMs: enabled ? quietMs : 0, maxWaitMs: enabled ? maxWaitMs : 0 });
  }

  recoverInterruptedBatches() {
    const batches = this.store.selectAll("SELECT * FROM session_collaboration_batches WHERE status IN ('prepared','dispatching')");
    for (const batch of batches) {
      const operation = this.store.getAgentTask(batch.operation_id);
      const receipt = operation?.deliveryId ? this.store.getMessageDelivery(operation.deliveryId) : null;
      const turnId = operation?.targetTurnId ?? receipt?.providerTurnId;
      if (turnId) this.mark(batch.batch_id, "accepted", { turnId });
      else if (batch.status === "prepared") {
        // Membership is frozen, but dispatch has not started. This is the one
        // crash window in which replay is proven safe.
        if (operation?.status === "running") this.store.updateAgentTask(operation.taskId, {
          status: "queued", startedAt: null, completedAt: null, lastError: null
        });
      } else {
        const error = "Backend restarted without a Provider turn receipt; batch was not resent.";
        this.mark(batch.batch_id, "unknown", { error });
        if (operation && ["queued", "running"].includes(operation.status)) {
          this.store.updateAgentTask(operation.taskId, { status: "failed", lastError: error });
        }
      }
    }
  }

  reconcileUncertainBatches() {
    const batches = this.store.selectAll("SELECT * FROM session_collaboration_batches WHERE status='unknown' ORDER BY updated_at LIMIT 100");
    for (const batch of batches) {
      const operation = this.store.getAgentTask(batch.operation_id);
      const receipt = operation?.deliveryId ? this.store.getMessageDelivery(operation.deliveryId) : null;
      if (!receipt?.providerTurnId) continue;
      const turn = this.store.getSessionTurn(receipt.sessionId, receipt.bindingId, receipt.providerTurnId);
      this.mark(batch.batch_id, "accepted", { turnId: receipt.providerTurnId });
      const turnStatus = turn?.execution_status ?? turn?.status;
      const terminal = ["completed", "failed", "cancelled"].includes(turnStatus);
      const otherRunning = this.store.getRunningAgentTaskForSession(operation.sessionId);
      this.store.updateAgentTask(operation.taskId, {
        targetTurnId: receipt.providerTurnId,
        ...(terminal ? { status: turnStatus } : !otherRunning ? { status: "running" } : {}),
        lastError: terminal && turnStatus !== "completed" ? operation.lastError : null
      });
    }
  }

  listWakeDeliveries(limit, maxAttempts) {
    // Select one wake head per mailbox, so a large backlog in one Channel
    // cannot consume the entire scan budget and hide other Channels.
    return this.store.selectAll(`WITH heads AS (
      SELECT d.delivery_id, o.sequence,
        ROW_NUMBER() OVER (PARTITION BY m.channel_id,m.sender_session_id,m.recipient_session_id,
          COALESCE(b.batch_id,'unbatched') ORDER BY COALESCE(mm.manual_requested,0) DESC,o.sequence) AS position
      FROM session_collaboration_deliveries d
      JOIN session_collaboration_messages m ON m.message_id=d.message_id
      JOIN session_collaboration_message_order o ON o.message_id=m.message_id
      LEFT JOIN session_collaboration_batch_items i ON i.delivery_id=d.delivery_id
      LEFT JOIN session_collaboration_batches b ON b.batch_id=i.batch_id
      LEFT JOIN session_mailbox_messages mm ON mm.channel_delivery_id=d.delivery_id
      WHERE (m.delivery_intent != 'acknowledgement' OR mm.manual_requested=1)
      AND COALESCE(mm.disposition,'pending')='pending' 
      AND d.status IN ('pending','queued','failed') AND d.attempt_count < ?
      AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
      AND (b.batch_id IS NULL OR b.status='prepared')
    ) SELECT delivery_id FROM heads WHERE position=1 ORDER BY sequence LIMIT ?`,
      [maxAttempts, new Date(this.clock()).toISOString(), limit])
      .map(row => this.service.getDelivery(row.delivery_id));
  }

  queueCreatedAt(envelope) {
    const latest = this.store.selectOne(`SELECT MAX(created_at) AS timestamp FROM session_collaboration_batches
      WHERE channel_id=? AND recipient_session_id=?`,
      [envelope.channel.channelId, envelope.message.recipientSessionId])?.timestamp;
    return latest && latest > envelope.delivery.createdAt ? latest : envelope.delivery.createdAt;
  }

  findQueuedHead(envelope, sessionId) {
    if (this.store.selectOne("SELECT manual_requested FROM session_mailbox_messages WHERE channel_delivery_id=?", [envelope.delivery.deliveryId])?.manual_requested) return null;
    const row = this.store.selectOne(`SELECT task_id FROM agent_operations
      WHERE session_id=? AND kind='collaboration' AND status='queued'
      AND json_extract(source_json,'$.type')='session_channel'
      AND json_extract(source_json,'$.channelId')=?
      AND json_extract(source_json,'$.senderSessionId')=?
      AND json_extract(source_json,'$.batchId') IS NULL ORDER BY created_at,task_id LIMIT 1`,
      [sessionId, envelope.channel.channelId, envelope.message.senderSessionId]);
    return row ? this.store.getAgentTask(row.task_id) : null;
  }

  shouldWake(deliveryId) {
    const envelope = this.service.getDeliveryEnvelope(deliveryId);
    return envelope && !SILENT.has(envelope.message.deliveryIntent);
  }

  getBatchForDelivery(deliveryId) {
    return this.store.selectOne(`SELECT b.* FROM session_collaboration_batches b
      JOIN session_collaboration_batch_items i ON i.batch_id=b.batch_id WHERE i.delivery_id=?`, [deliveryId]);
  }

  getItems(batchId) {
    return this.store.selectAll(`SELECT delivery_id FROM session_collaboration_batch_items
      WHERE batch_id=? ORDER BY batch_order`, [batchId])
      .map(row => this.service.getDeliveryEnvelope(row.delivery_id));
  }

  candidates(deliveryId, operationId = null) {
    const head = this.service.getDeliveryEnvelope(deliveryId);
    if (!head) return [];
    const barrier = operationId ? this.store.selectOne(`SELECT MIN(created_at) AS cutoff FROM agent_operations
      WHERE session_id=(SELECT session_id FROM agent_operations WHERE task_id=?)
      AND status='queued' AND kind!='collaboration'
      AND created_at >= (SELECT created_at FROM agent_operations WHERE task_id=?)`, [operationId, operationId])?.cutoff : null;
    const sequence = this.store.selectOne("SELECT sequence FROM session_collaboration_message_order WHERE message_id=?", [head.message.messageId]).sequence;
    return this.store.selectAll(`SELECT d.delivery_id, o.sequence FROM session_collaboration_deliveries d
      JOIN session_collaboration_messages m ON m.message_id=d.message_id
      JOIN session_collaboration_message_order o ON o.message_id=m.message_id
      LEFT JOIN session_collaboration_batch_items i ON i.delivery_id=d.delivery_id
      LEFT JOIN session_mailbox_messages mm ON mm.channel_delivery_id=d.delivery_id
      WHERE COALESCE(mm.disposition,'pending')='pending'
      AND (NOT EXISTS(SELECT 1 FROM session_mailbox_settings ms WHERE ms.recipient_session_id=m.recipient_session_id AND ms.paused=1) OR mm.manual_requested=1)
      AND m.channel_id=? AND m.sender_session_id=? AND m.recipient_session_id=?
      AND d.status IN ('pending','queued') AND i.delivery_id IS NULL
      ${barrier ? "AND (m.created_at < ? OR d.delivery_id=?)" : ""}
      ORDER BY (o.sequence >= ?) DESC, o.sequence LIMIT ?`, [head.channel.channelId, head.message.senderSessionId,
      head.message.recipientSessionId, ...(barrier ? [barrier, deliveryId] : []), sequence, this.maxMessages + 1])
      .sort((a, b) => a.sequence - b.sequence)
      .map(row => this.service.getDeliveryEnvelope(row.delivery_id));
  }

  waitMs(deliveryId, operationId) {
    if (this.store.selectOne("SELECT manual_requested FROM session_mailbox_messages WHERE channel_delivery_id=?", [deliveryId])?.manual_requested) return 0;
    if (this.getBatchForDelivery(deliveryId)) return 0;
    const items = this.candidates(deliveryId, operationId).filter(item => !SILENT.has(item.message.deliveryIntent));
    if (!items.length || items.length >= this.maxMessages) return 0;
    const times = items.map(item => Date.parse(item.message.createdAt));
    return Math.max(0, Math.min(Math.min(...times) + this.maxWaitMs, Math.max(...times) + this.quietMs) - this.clock());
  }

  prepareBatch(deliveryId, operationId) {
    const existing = this.getBatchForDelivery(deliveryId);
    if (existing) return existing;
    let batch;
    this.store.runInTransaction(() => {
      const candidates = this.candidates(deliveryId, operationId);
      const anchor = candidates.findIndex(item => item.delivery.deliveryId === deliveryId);
      if (anchor < 0) throw new Error("Channel delivery is no longer available for batching.");
      // Always include the wake-triggering request. Older silent notifications
      // must never exhaust the budget before that request is included.
      const selected = [candidates[anchor]];
      const batchId = `channel_batch:${randomUUID()}`;
      const binding = candidates[anchor].message.resourceContext?.recipient;
      for (const item of candidates.slice(anchor + 1)) {
        if (!sameRecipientContext(binding, item.message.resourceContext?.recipient)) break;
        if (selected.length >= this.maxMessages) break;
        if (Buffer.byteLength(formatTrustedChannelBatch([...selected, item], batchId), "utf8") > this.maxBytes) break;
        selected.push(item);
      }
      for (const item of candidates.slice(0, anchor).reverse()) {
        if (!SILENT.has(item.message.deliveryIntent)) break;
        if (!sameRecipientContext(binding, item.message.resourceContext?.recipient)) break;
        if (selected.length >= this.maxMessages) break;
        if (Buffer.byteLength(formatTrustedChannelBatch([item, ...selected], batchId), "utf8") > this.maxBytes) break;
        selected.unshift(item);
      }
      if (Buffer.byteLength(formatTrustedChannelBatch(selected, batchId), "utf8") > this.maxBytes) {
        const error = new Error("Channel message exceeds the batch input budget. Send an Artifact reference instead.");
        error.code = "CHANNEL_MESSAGE_TOO_LARGE";
        throw error;
      }
      const timestamp = new Date(this.clock()).toISOString();
      this.store.db.run(`INSERT INTO session_collaboration_batches
        (batch_id,operation_id,channel_id,recipient_session_id,status,created_at,updated_at)
        VALUES(?,?,?,?,'prepared',?,?)`, [batchId, operationId, selected[0].channel.channelId,
        selected[0].message.recipientSessionId, timestamp, timestamp]);
      selected.forEach((item, index) => {
        const oldRow = this.store.selectOne("SELECT task_id FROM agent_operations WHERE channel_delivery_id=?", [item.delivery.deliveryId]);
        const old = oldRow ? this.store.getAgentTask(oldRow.task_id) : null;
        this.store.db.run(`INSERT INTO session_collaboration_batch_items(batch_id,delivery_id,batch_order) VALUES(?,?,?)`,
          [batchId, item.delivery.deliveryId, index]);
        if (old && old.taskId !== operationId && old.status === "queued") {
          this.store.updateAgentTask(old.taskId, { status: "cancelled", source: { ...old.source, batchedInto: batchId } });
        }
      });
      const operation = this.store.getAgentTask(operationId);
      this.store.updateAgentTask(operationId, { source: { ...operation.source, batchId,
        messageIds: selected.map(item => item.message.messageId),
        messageCount: selected.length,
        presentationText: batchPresentation(selected) } });
      batch = this.getBatchForDelivery(deliveryId);
    });
    this.store.scheduleSave();
    return batch;
  }

  mark(batchId, status, { turnId = null, error = null } = {}) {
    const timestamp = new Date(this.clock()).toISOString();
    this.store.runInTransaction(() => {
      this.store.db.run(`UPDATE session_collaboration_batches SET status=?,target_turn_id=?,last_error=?,updated_at=?
        WHERE batch_id=?`, [status, turnId, error, timestamp, batchId]);
      for (const item of this.getItems(batchId)) {
        this.service.updateDelivery(item.delivery.deliveryId, {
          status: status === "accepted" ? "delivered" : status === "prepared" ? "queued" : "delivering",
          targetTurnId: turnId, lastError: error,
          ...(status === "accepted" ? { deliveredAt: timestamp } : {})
        });
      }
    });
    this.store.scheduleSave();
    if (this.sessionMailbox) {
      const item = this.getItems(batchId)[0];
      if (item) this.sessionMailbox.notify(this.sessionMailbox.logical(item.message.recipientSessionId));
    }
  }
}

export function batchPresentation(items) {
  if (items.length === 1) return items[0].message.body;
  return `协作消息 · 已合并 ${items.length} 条\n\n` + items.map((item, index) =>
    `${index + 1}. [${item.message.createdAt}] ${item.message.body}`).join("\n\n");
}

function sameRecipientContext(left = {}, right = {}) {
  return ["workId", "taskId", "routingVersion"].every(key => (left[key] ?? null) === (right[key] ?? null));
}
