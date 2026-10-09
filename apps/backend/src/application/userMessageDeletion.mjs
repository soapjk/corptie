const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });

/** Only proven never-dispatched messages. Provider history is never rewritten. */
export function userMessageDeletionEligibility(store, sessionId, messageId) {
  const deleted = store.selectOne("SELECT 1 FROM deleted_user_messages WHERE session_id=? AND message_id=?", [sessionId, messageId]);
  if (deleted) return { available: true, deleted: true };
  const item = store.getSessionItem(sessionId, messageId);
  if (!item || item.type !== "userMessage") return { available: false, reason: "MESSAGE_NOT_FOUND" };
  const delivery = store.getMessageDeliveryForMessage(messageId);
  if (!delivery || delivery.sessionId !== sessionId) return { available: false, reason: "MESSAGE_DELIVERY_UNPROVEN" };
  if (!["failed", "cancelled"].includes(delivery.status)
      || delivery.attemptCount !== 0 || delivery.lastAttemptAt
      || delivery.providerTurnId || delivery.providerAcknowledgedAt) {
    return { available: false, reason: "MESSAGE_MAY_HAVE_BEEN_RECEIVED" };
  }
  const tasks = store.selectAll(`SELECT * FROM agent_operations WHERE session_id=?
    AND (task_id=? OR json_extract(source_json, '$.messageId')=?)`, [sessionId, messageId, messageId]);
  if (!tasks.length || tasks.some(task => task.kind !== "user" || !["failed", "cancelled"].includes(task.status)
      || task.started_at || task.target_turn_id)) return { available: false, reason: "MESSAGE_MAY_HAVE_BEEN_RECEIVED" };
  return { available: true, delivery, tasks };
}

export function deleteUnreceivedUserMessage(store, sessionId, messageId) {
  if (typeof messageId !== "string" || !messageId || messageId.length > 512) throw failure("INVALID_MESSAGE_ID", 400);
  return store.runInTransaction(() => {
    const eligibility = userMessageDeletionEligibility(store, sessionId, messageId);
    if (!eligibility.available) throw failure(eligibility.reason);
    if (eligibility.deleted) return { schemaVersion: 1, messageId, status: "deleted" };
    const { delivery, tasks } = eligibility;
    const now = new Date().toISOString();
    store.db.run("INSERT INTO deleted_user_messages VALUES (?, ?, ?, ?)", [sessionId, messageId, tasks[0].task_id, now]);
    // Retain terminal operation/delivery identity for at-most-once admission,
    // but remove all message content and attachment references from these rows.
    for (const task of tasks) {
      store.db.run("UPDATE agent_operations SET text='', source_json=?, last_error=NULL, status='cancelled' WHERE task_id=? AND session_id=?",
        [JSON.stringify({ messageId, deliveryId: delivery.deliveryId, deleted: true }), task.task_id, sessionId]);
    }
    store.db.run("UPDATE message_deliveries SET status='cancelled', source_json='{}', last_error=NULL WHERE delivery_id=?",
      [delivery.deliveryId]);
    // Keep event sequence/identity, not its original user content. No Provider
    // event can exist for a message admitted by the conservative guard above.
    store.db.run(`UPDATE session_events SET source_json='{}', payload_json=?, surface=0
      WHERE session_id=? AND (event_id=? OR json_extract(payload_json,'$.message.id')=?
        OR json_extract(payload_json,'$.deliveryId')=? OR json_extract(source_json,'$.messageId')=?
        OR json_extract(payload_json,'$.task.source.messageId')=?)`,
      [JSON.stringify({ messageId, deleted: true }), sessionId, `user-message:${messageId}`, messageId,
        delivery.deliveryId, messageId, messageId]);
    store.db.run(`UPDATE event_outbox SET payload_json=?, status='published', last_error=NULL
      WHERE session_id=? AND (json_extract(payload_json,'$.messageId')=? OR json_extract(payload_json,'$.deliveryId')=?)`,
      [JSON.stringify({ messageId, deleted: true }), sessionId, messageId, delivery.deliveryId]);
    store.removeItem(sessionId, messageId); // Existing revisioned delta records removal.
    store.scheduleSave();
    return { schemaVersion: 1, messageId, status: "deleted" };
  });
}
