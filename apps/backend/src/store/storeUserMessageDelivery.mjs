import { createdAtFromOrNow } from "../utils/timestamps.mjs";

// One transaction commits the user message projection, event, outbox and work.
export function createUserMessageDelivery(store, {
  deliveryId,
  messageId,
  sessionId,
  binding,
  agentId,
  text,
  content = null,
  title = "User",
  source = {},
  priority = 100,
  createdAt = createdAtFromOrNow()
}) {
  return store.runInTransaction(() => {
    if (source.clientReceipt) {
      const receipt = source.clientReceipt;
      store.db.run(`INSERT INTO client_message_receipts
        (device_id, request_id, session_id, payload_hash, accepted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [receipt.deviceId, receipt.requestId, sessionId, receipt.payloadHash, receipt.acceptedAt, receipt.expiresAt]);
      // Transport audit data is private; never project it into ordinary messages.
      source = { ...source };
      delete source.clientReceipt;
      // Millisecond collisions must not let task-ID lexical order reorder
      // consecutive instructions admitted by the reliable sender.
      const last = store.selectOne("SELECT MAX(created_at) AS timestamp FROM agent_operations WHERE session_id=?", [sessionId]);
      const previous = Date.parse(last?.timestamp);
      createdAt = new Date(Math.max(Date.parse(createdAt), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    }
    const { inserted, delivery: existing } = store.messageDeliveryRepository.insertUserMessageDelivery({
      deliveryId, messageId, sessionId, binding, source, createdAt
    });
    let outbox = null;
    if (inserted) {
      const images = Array.isArray(content?.images) ? content.images : [];
      store.upsertTimelineItemProjection(sessionId, {
        id: messageId,
        bindingId: binding.bindingId,
        turnId: `delivery:${deliveryId}`,
        turnStatus: "inProgress",
        type: "userMessage",
        title,
        text,
        rawMetadataJSON: images.length > 0 ? JSON.stringify({ images }) : null,
        status: "queued",
        createdAt
      });
      store.appendSessionEvent({
        eventId: `user-message:${messageId}`,
        sessionId,
        type: "SessionUserMessageCreated",
        producer: "user",
        surface: true,
        source,
        payload: {
          sessionId,
          message: { id: messageId, type: "userMessage", title, text, images, createdAt },
          deliveryId,
          bindingId: binding.bindingId,
          routingVersion: binding.routingVersion
        },
        createdAt
      });
      outbox = store.enqueueEventOutbox({
        outboxId: `message-delivery:${deliveryId}:queued`,
        topic: "provider-commands",
        sessionId,
        eventType: "MessageDeliveryQueued",
        payload: { deliveryId, messageId, sessionId },
        createdAt
      });
    }
    const work = store.enqueueAgentTaskWithResult({
      taskId: messageId,
      agentId,
      sessionId,
      kind: "user",
      priority,
      text,
      source: { ...source, messageId, deliveryId },
      localVisibility: "normal",
      createdAt
    }).task;
    return {
      inserted,
      delivery: existing,
      message: store.getSessionItem(sessionId, messageId),
      task: work,
      outbox: outbox ?? null
    };
  });
}
