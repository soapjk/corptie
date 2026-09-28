import { channelFromRow } from "./collaborationRecordProjection.mjs";
import { requiredId, domainError } from "./collaborationValidation.mjs";

// Task-linked channel lifecycle. Callers retain the surrounding delivery/Session
// transaction; standalone route invalidation uses the injected transaction port.
export class CollaborationTaskChannels {
  constructor({ store, clock, idFactory, terminalTaskStatuses, getDeliveryEnvelope, getAgentForSession, sessionIdentityMatches, stableSessionIdentity, appendEvent, transaction }) {
    Object.assign(this, { store, clock, idFactory, terminalTaskStatuses, getDeliveryEnvelope, getAgentForSession, sessionIdentityMatches, stableSessionIdentity, appendEvent, transaction });
  }

  getChannel(taskId) {
    const row = this.store.selectOne(
      "SELECT * FROM collaboration_channels WHERE task_id = ?",
      [requiredId(taskId, "taskId")]
    );
    return row ? channelFromRow(row) : null;
  }

  resolveDirectReplyRoute(deliveryId) {
    const envelope = this.getDeliveryEnvelope(deliveryId);
    if (!envelope) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
    const reply = this.#isReplyEnvelope(envelope);

    const channel = this.getChannel(envelope.task.taskId);
    if (channel?.status === "active") {
      const senderSessionId = this.stableSessionIdentity(envelope.message.envelope.sender.sessionId);
      const expectedSenderSessionId = reply ? channel.recipientSessionId : channel.initiatorSessionId;
      const expectedSenderAgentId = reply ? channel.recipientAgentId : channel.initiatorAgentId;
      const expectedRecipientAgentId = reply ? channel.initiatorAgentId : channel.recipientAgentId;
      const targetSessionId = reply ? channel.initiatorSessionId : channel.recipientSessionId;
      if (senderSessionId === expectedSenderSessionId
          && envelope.message.senderAgentId === expectedSenderAgentId
          && envelope.delivery.recipientAgentId === expectedRecipientAgentId) {
        const route = this.#activeProviderRoute(targetSessionId, expectedRecipientAgentId);
        if (route) return { ...route, mode: "channel", channel };
        this.#invalidateChannel(channel.channelId, reply ? "initiator_session_unavailable" : "recipient_session_unavailable");
      } else {
        this.#invalidateChannel(channel.channelId, "task_endpoint_mismatch");
      }
    }

    if (!reply) return null;
    const fallbackSessionId = this.stableSessionIdentity(envelope.message.envelope.recipient.sessionId);
    const fallback = this.#activeProviderRoute(fallbackSessionId, envelope.delivery.recipientAgentId);
    if (fallback) return { ...fallback, mode: "fallback", channel: this.getChannel(envelope.task.taskId) };
    throw domainError(
      "COLLABORATION_CHANNEL_UNAVAILABLE",
      `No valid collaboration channel or original Session route remains for task ${envelope.task.taskId}.`
    );
  }

  #isReplyEnvelope(envelope) {
    return this.sessionIdentityMatches(
      envelope.message.envelope.sender.sessionId,
      envelope.task.recipientSessionId
    ) && this.sessionIdentityMatches(
      envelope.message.envelope.recipient.sessionId,
      envelope.task.initiatorSessionId
    );
  }

  #activeProviderRoute(sessionId, agentId) {
    if (!sessionId) return null;
    const logical = this.store.getLogicalSession(sessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    const providerSessionId = logical?.legacySessionId ?? sessionId;
    const session = this.store.getSession(providerSessionId);
    if ((logical && !logical.activeBinding) || session?.archived) return null;
    const bound = this.getAgentForSession(providerSessionId);
    if ((!session && !bound) || bound?.agentId !== agentId) return null;
    return {
      sessionId: logical?.logicalSessionId ?? sessionId,
      providerSessionId
    };
  }

  establishChannel(deliveryId, targetSessionId, timestamp) {
    const envelope = this.getDeliveryEnvelope(deliveryId);
    if (!envelope) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
    const targetStableId = this.stableSessionIdentity(targetSessionId);
    const senderStableId = this.stableSessionIdentity(envelope.message.envelope.sender.sessionId);
    if (!senderStableId || !targetStableId) {
      this.appendEvent(envelope.task.taskId, "collaboration_channel_unavailable", null, {
        deliveryId,
        reason: "session_endpoint_missing"
      }, timestamp);
      return null;
    }
    const reply = this.#isReplyEnvelope(envelope);
    const initiatorSessionId = reply ? targetStableId : senderStableId;
    const recipientSessionId = reply ? senderStableId : targetStableId;
    const existing = this.getChannel(envelope.task.taskId);
    const initiatorRoute = this.#activeProviderRoute(initiatorSessionId, envelope.task.initiatorAgentId);
    const recipientRoute = this.#activeProviderRoute(recipientSessionId, envelope.task.recipientAgentId);
    if (!initiatorRoute || !recipientRoute) {
      if (existing?.status === "active") {
        this.store.db.run(
          `UPDATE collaboration_channels SET status='invalid', invalidated_reason=?,
           invalidated_at=?, updated_at=? WHERE channel_id=? AND status='active'`,
          ["session_endpoint_unavailable_after_delivery", timestamp, timestamp, existing.channelId]
        );
      }
      this.appendEvent(envelope.task.taskId, "collaboration_channel_unavailable", null, {
        channelId: existing?.channelId ?? null,
        deliveryId,
        reason: "session_endpoint_unavailable_after_delivery"
      }, timestamp);
      return null;
    }
    const channelId = existing?.channelId ?? this.idFactory();
    this.store.db.run(
      `INSERT INTO collaboration_channels (
        channel_id, task_id, initiator_agent_id, recipient_agent_id,
        initiator_session_id, recipient_session_id, status,
        established_delivery_id, last_delivery_id, invalidated_reason,
        established_at, updated_at, invalidated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, NULL, NULL)
      ON CONFLICT(task_id) DO UPDATE SET
        initiator_agent_id=excluded.initiator_agent_id,
        recipient_agent_id=excluded.recipient_agent_id,
        initiator_session_id=excluded.initiator_session_id,
        recipient_session_id=excluded.recipient_session_id,
        status='active', last_delivery_id=excluded.last_delivery_id,
        invalidated_reason=NULL, updated_at=excluded.updated_at,
        invalidated_at=NULL, closed_at=NULL`,
      [
        channelId, envelope.task.taskId, envelope.task.initiatorAgentId, envelope.task.recipientAgentId,
        initiatorSessionId, recipientSessionId, deliveryId, deliveryId, timestamp, timestamp
      ]
    );
    this.appendEvent(envelope.task.taskId, existing ? "collaboration_channel_updated" : "collaboration_channel_established", null, {
      channelId,
      deliveryId,
      initiatorSessionId,
      recipientSessionId
    }, timestamp);
  }

  #invalidateChannel(channelId, reason) {
    const channel = this.store.selectOne(
      "SELECT * FROM collaboration_channels WHERE channel_id = ? AND status = 'active'",
      [channelId]
    );
    if (!channel) return null;
    const timestamp = this.clock();
    this.transaction(() => {
      this.store.db.run(
        `UPDATE collaboration_channels SET status='invalid', invalidated_reason=?,
         invalidated_at=?, updated_at=? WHERE channel_id=? AND status='active'`,
        [reason, timestamp, timestamp, channelId]
      );
      this.appendEvent(channel.task_id, "collaboration_channel_invalidated", null, {
        channelId,
        reason
      }, timestamp);
    });
    return this.getChannel(channel.task_id);
  }

  invalidateChannelsForSession(sessionId, reason, timestamp) {
    if (!sessionId) return;
    const channels = this.store.selectAll(
      `SELECT channel_id, task_id FROM collaboration_channels
       WHERE status='active' AND (initiator_session_id=? OR recipient_session_id=?)`,
      [sessionId, sessionId]
    );
    for (const channel of channels) {
      this.store.db.run(
        `UPDATE collaboration_channels SET status='invalid', invalidated_reason=?,
         invalidated_at=?, updated_at=? WHERE channel_id=? AND status='active'`,
        [reason, timestamp, timestamp, channel.channel_id]
      );
      this.appendEvent(channel.task_id, "collaboration_channel_invalidated", null, {
        channelId: channel.channel_id,
        reason,
        sessionId
      }, timestamp);
    }
  }

  closeChannelIfSettled(deliveryId, timestamp) {
    const row = this.store.selectOne(
      `SELECT t.task_id, t.status, c.channel_id,
              (SELECT COUNT(*) FROM collaboration_deliveries pending
               JOIN collaboration_messages pm ON pm.message_id=pending.message_id
               WHERE pm.task_id=t.task_id AND pending.status!='delivered') AS unsettled_count
       FROM collaboration_deliveries d
       JOIN collaboration_messages m ON m.message_id=d.message_id
       JOIN collaboration_requests t ON t.task_id=m.task_id
       LEFT JOIN collaboration_channels c ON c.task_id=t.task_id AND c.status='active'
       WHERE d.delivery_id=?`,
      [deliveryId]
    );
    if (!row?.channel_id || !this.terminalTaskStatuses.has(row.status) || Number(row.unsettled_count) > 0) return;
    this.store.db.run(
      `UPDATE collaboration_channels SET status='closed', closed_at=?, updated_at=?
       WHERE channel_id=? AND status='active'`,
      [timestamp, timestamp, row.channel_id]
    );
    this.appendEvent(row.task_id, "collaboration_channel_closed", null, {
      channelId: row.channel_id,
      reason: "task_terminal"
    }, timestamp);
  }
}
