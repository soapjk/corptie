import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";
import { requiredText } from "../validation.mjs";

export class MessageDeliveryRepository {
  constructor({ getDatabase, selectAll, selectOne, runInTransaction, notifyTimelineDirty }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.runInTransaction = runInTransaction;
    this.notifyTimelineDirty = notifyTimelineDirty;
  }

  get db() {
    return this.getDatabase();
  }

  getMessageDelivery(deliveryId) {
    const row = this.selectOne("SELECT * FROM message_deliveries WHERE delivery_id = ?", [deliveryId]);
    return row ? messageDeliveryFromRow(row) : null;
  }

  getMessageDeliveryForMessage(messageId) {
    const row = this.selectOne("SELECT * FROM message_deliveries WHERE message_id = ?", [messageId]);
    return row ? messageDeliveryFromRow(row) : null;
  }

  getMessageDeliveryForProviderTurn(sessionId, bindingId, providerTurnId) {
    if (!providerTurnId) return null;
    const row = this.selectOne(
      `SELECT * FROM message_deliveries
       WHERE session_id = ? AND binding_id = ? AND provider_turn_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, bindingId, providerTurnId]
    );
    return row ? messageDeliveryFromRow(row) : null;
  }

  claimDispatchingMessageDeliveryForProviderTurn(
    sessionId,
    bindingId,
    providerTurnId,
    acknowledgedAt = createdAtFromOrNow()
  ) {
    if (!providerTurnId) return null;
    const existing = this.getMessageDeliveryForProviderTurn(sessionId, bindingId, providerTurnId);
    if (existing) return existing;
    const candidates = this.selectAll(
      `SELECT * FROM message_deliveries
       WHERE session_id = ? AND binding_id = ?
         AND provider_turn_id IS NULL AND status = 'dispatching'
       ORDER BY last_attempt_at ASC, created_at ASC, delivery_id ASC
       LIMIT 2`,
      [sessionId, bindingId]
    );
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      const error = new Error("More than one dispatching Delivery can claim the Provider Turn.");
      error.code = "MESSAGE_DELIVERY_CORRELATION_AMBIGUOUS";
      throw error;
    }
    const delivery = messageDeliveryFromRow(candidates[0]);
    return this.updateMessageDelivery(delivery.deliveryId, {
      status: "processing",
      providerTurnId,
      providerAcknowledgedAt: acknowledgedAt,
      lastError: null,
      updatedAt: acknowledgedAt
    });
  }

  insertUserMessageDelivery({ deliveryId, messageId, sessionId, binding, source, createdAt }) {
    this.db.run(
      `INSERT OR IGNORE INTO message_deliveries (
        delivery_id, message_id, session_id, binding_id, routing_version,
        provider_id, provider_session_id, status, source_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [
        deliveryId,
        messageId,
        sessionId,
        binding.bindingId,
        binding.routingVersion,
        binding.providerId,
        binding.providerSessionId,
        JSON.stringify(source),
        createdAt,
        createdAt
      ]
    );
    const inserted = this.db.getRowsModified() > 0;
    const existing = this.getMessageDelivery(deliveryId)
      ?? this.getMessageDeliveryForMessage(messageId);
    if (!existing) throw new Error("Message Delivery could not be persisted.");
    if (!inserted && (existing.sessionId !== sessionId || existing.messageId !== messageId)) {
      const error = new Error("Message Delivery idempotency key conflicts with another message.");
      error.code = "MESSAGE_DELIVERY_CONFLICT";
      throw error;
    }
    return { inserted, delivery: existing };
  }

  updateMessageDelivery(deliveryId, patch = {}) {
    return this.runInTransaction(() => {
      const current = this.getMessageDelivery(deliveryId);
      if (!current) return null;
      const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
      const status = value("status", current.status);
      const updatedAt = value("updatedAt", createdAtFromOrNow());
      this.db.run(
        `UPDATE message_deliveries SET
          status = ?, attempt_count = ?, provider_turn_id = ?, last_attempt_at = ?,
          provider_acknowledged_at = ?, last_error = ?, updated_at = ?
         WHERE delivery_id = ?`,
        [
          status,
          value("attemptCount", current.attemptCount),
          value("providerTurnId", current.providerTurnId),
          value("lastAttemptAt", current.lastAttemptAt),
          value("providerAcknowledgedAt", current.providerAcknowledgedAt),
          value("lastError", current.lastError),
          updatedAt,
          deliveryId
        ]
      );
      const messageStatus = status === "delivery_unknown" ? "unknown" : status;
      this.db.run(
        `UPDATE session_items SET
           status = ?,
           turn_id = COALESCE(?, turn_id)
         WHERE session_id = ? AND id = ?
           AND (status IS NOT ? OR (? IS NOT NULL AND turn_id IS NOT ?))`,
        [
          messageStatus,
          value("providerTurnId", current.providerTurnId),
          current.sessionId,
          current.messageId,
          messageStatus,
          value("providerTurnId", current.providerTurnId),
          value("providerTurnId", current.providerTurnId)
        ]
      );
      if (this.db.getRowsModified() > 0) this.notifyTimelineDirty(current.sessionId);
      return this.getMessageDelivery(deliveryId);
    });
  }

  rerouteUnsentMessageDelivery(deliveryId, binding) {
    return this.runInTransaction(() => {
      const current = this.getMessageDelivery(deliveryId);
      if (!current) return null;
      if (!["queued", "dispatching"].includes(current.status)
        || current.providerTurnId
        || current.providerAcknowledgedAt) {
        const error = new Error(`Message Delivery ${deliveryId} is no longer safe to reroute.`);
        error.code = "MESSAGE_DELIVERY_REROUTE_UNSAFE";
        throw error;
      }
      const bindingId = requiredText(binding?.bindingId, "binding.bindingId");
      const providerId = requiredText(binding?.providerId, "binding.providerId");
      const providerSessionId = requiredText(binding?.providerSessionId, "binding.providerSessionId");
      const routingVersion = Number(binding?.routingVersion);
      if (!Number.isInteger(routingVersion) || routingVersion < 1) {
        throw new TypeError("binding.routingVersion must be a positive integer.");
      }
      const updatedAt = createdAtFromOrNow();
      this.db.run(
        `UPDATE message_deliveries SET
           binding_id = ?, routing_version = ?, provider_id = ?, provider_session_id = ?, updated_at = ?
         WHERE delivery_id = ?`,
        [bindingId, routingVersion, providerId, providerSessionId, updatedAt, deliveryId]
      );
      return this.getMessageDelivery(deliveryId);
    });
  }
}

function messageDeliveryFromRow(row) {
  return {
    deliveryId: row.delivery_id,
    messageId: row.message_id,
    sessionId: row.session_id,
    bindingId: row.binding_id,
    routingVersion: Number(row.routing_version),
    providerId: row.provider_id,
    providerSessionId: row.provider_session_id,
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    providerTurnId: row.provider_turn_id ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    providerAcknowledgedAt: row.provider_acknowledged_at ?? null,
    lastError: row.last_error ?? null,
    source: parseJson(row.source_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
