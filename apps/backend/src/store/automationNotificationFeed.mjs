import { randomUUID } from "node:crypto";

const terminalKinds = {
  ScheduledSessionRunCompleted: "completed", ScheduledSessionRunFailed: "failed",
  ScheduledSessionRunMissed: "failed", ScheduledSessionRunCancelled: "cancelled",
  ScheduledSessionTaskCancelled: "cancelled", ScheduledSessionTaskExpired: "expired"
};

// Called inside the same Store transaction as the authoritative scheduled event.
// No prompts, commands, paths or Provider payloads enter this device projection.
export function recordAutomationNotification(store, event, task) {
  const kind = terminalKinds[event.type];
  if (!kind || event.payload?.willRetry === true || !task) return;
  const value = { eventId: event.eventId, automationId: event.taskId, runId: event.runId ?? null,
    logicalSessionId: task.logicalSessionId, name: task.name ?? "", kind,
    occurredAt: event.createdAt, scheduleType: task.scheduleType };
  store.db.run(`INSERT OR IGNORE INTO automation_notification_feed
    (event_id, environment, created_at, body_json) VALUES (?, ?, ?, ?)`,
  [event.eventId, event.environment, event.createdAt, JSON.stringify(value)]);
  // Retain 30 days for recovery; the independent clock prevents cursor reuse.
  store.db.run("DELETE FROM automation_notification_feed WHERE created_at < ?",
    [new Date(Date.parse(event.createdAt) - 30 * 86400000).toISOString()]);
}

export function readAutomationNotifications(store, environment, cursor, now = new Date()) {
  store.db.run("INSERT OR IGNORE INTO automation_notification_clock (id, epoch) VALUES (1, ?)", [randomUUID()]);
  const epoch = store.selectOne("SELECT epoch FROM automation_notification_clock WHERE id = 1").epoch;
  // sqlite_sequence survives retention/deletion, unlike MAX(rowid).
  const head = Number(store.selectOne("SELECT seq FROM sqlite_sequence WHERE name = 'automation_notification_feed'")?.seq ?? 0);
  const encode = sequence => Buffer.from(JSON.stringify({ epoch, sequence })).toString("base64url");
  let previous;
  try { previous = JSON.parse(Buffer.from(cursor ?? "", "base64url").toString()); } catch { }
  const oldest = store.selectOne("SELECT MIN(sequence) AS sequence FROM automation_notification_feed")?.sequence;
  if (!previous || previous.epoch !== epoch || !Number.isSafeInteger(previous.sequence)
      || previous.sequence < 0 || previous.sequence > head || (oldest != null && previous.sequence < oldest - 1)) {
    return { schemaVersion: 1, cursor: encode(head), reset: true, hasMore: false, events: [] };
  }
  const rows = store.selectAll(`SELECT sequence, body_json FROM automation_notification_feed
    WHERE sequence > ? AND sequence <= ? AND environment = ? AND created_at >= ?
    ORDER BY sequence LIMIT 129`, [previous.sequence, head, environment, new Date(now.getTime() - 15 * 60000).toISOString()]);
  const hasMore = rows.length > 128;
  const page = rows.slice(0, 128);
  return { schemaVersion: 1, cursor: encode(hasMore ? page.at(-1).sequence : head), reset: false, hasMore,
    events: page.map(row => ({ ...JSON.parse(row.body_json), sequence: row.sequence })) };
}
