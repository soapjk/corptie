import { parseJson } from "../store/storedJson.mjs";

const failure = code => Object.assign(new Error({
  MESSAGE_MAY_HAVE_BEEN_RECEIVED: "消息已经开始处理，无法撤回。",
  MESSAGE_NOT_FOUND: "找不到这条消息，请刷新后重试。",
  MESSAGE_DELIVERY_UNPROVEN: "尚不能确认消息是否送达，请刷新状态后重试。"
}[code] ?? "撤回失败，请刷新后重试。"), { code, status: code === "INVALID_MESSAGE_ID" ? 400 : 409 });

// Provider-neutral: only work which has provably never entered dispatch may
// be withdrawn. The same transaction serializes this check with task claims.
export function userMessageWithdrawalEligibility(store, sessionId, messageId) {
  const item = store.getSessionItem(sessionId, messageId);
  if (!item || item.type !== "userMessage") return { available: false, reason: "MESSAGE_NOT_FOUND" };
  if (item.withdrawnMessage) return { available: false, withdrawn: true, item };
  const delivery = store.getMessageDeliveryForMessage(messageId);
  if (!delivery || delivery.sessionId !== sessionId) return { available: false, reason: "MESSAGE_DELIVERY_UNPROVEN" };
  if (!["queued", "failed", "cancelled"].includes(delivery.status) || delivery.attemptCount !== 0
      || delivery.lastAttemptAt || delivery.providerTurnId || delivery.providerAcknowledgedAt) {
    return { available: false, reason: "MESSAGE_MAY_HAVE_BEEN_RECEIVED" };
  }
  const tasks = store.selectAll(`SELECT * FROM agent_operations WHERE session_id=?
    AND (task_id=? OR json_extract(source_json, '$.messageId')=?)`, [sessionId, messageId, messageId]);
  if (!tasks.length || tasks.some(task => task.kind !== "user" || !["queued", "failed", "cancelled"].includes(task.status)
      || task.started_at || task.target_turn_id)) return { available: false, reason: "MESSAGE_MAY_HAVE_BEEN_RECEIVED" };
  return { available: true, item, delivery, tasks };
}

export function withdrawUnreceivedUserMessage(store, sessionId, messageId) {
  if (typeof messageId !== "string" || !messageId || messageId.length > 512) throw failure("INVALID_MESSAGE_ID");
  return store.runInTransaction(() => {
    const eligibility = userMessageWithdrawalEligibility(store, sessionId, messageId);
    if (eligibility.withdrawn) return { schemaVersion: 1, messageId, status: "withdrawn" };
    if (!eligibility.available) throw failure(eligibility.reason);
    const { item, delivery, tasks } = eligibility;
    const metadata = parseJson(item.rawMetadataJSON, {}) ?? {};
    const withdrawnMessage = { text: item.text, images: item.images ?? metadata.images ?? [] };
    const now = new Date().toISOString();
    for (const task of tasks) {
      const source = { ...parseJson(task.source_json, {}), withdrawnMessage };
      store.db.run(`UPDATE agent_operations SET status='cancelled', text='', source_json=?,
        last_error=NULL, completed_at=?, updated_at=? WHERE session_id=? AND task_id=?`,
      [JSON.stringify(source), now, now, sessionId, task.task_id]);
    }
    store.db.run("UPDATE message_deliveries SET status='cancelled', last_error=NULL WHERE delivery_id=?", [delivery.deliveryId]);
    store.db.run(`UPDATE event_outbox SET status='published', last_error=NULL
      WHERE session_id=? AND (json_extract(payload_json,'$.messageId')=? OR json_extract(payload_json,'$.deliveryId')=?)`,
    [sessionId, messageId, delivery.deliveryId]);
    store.upsertTimelineItemProjection(sessionId, { ...item, text: "已撤回", status: "cancelled", turnStatus: "cancelled",
      presentationText: "已撤回", rawMetadataJSON: JSON.stringify({ ...metadata,
        withdrawnMessage, withdrawalAvailable: false, deletionAvailable: false, images: [],
        userMessageStatus: "cancelled", queuePosition: null, processingError: null }) });
    store.scheduleSave();
    return { schemaVersion: 1, messageId, status: "withdrawn" };
  });
}
