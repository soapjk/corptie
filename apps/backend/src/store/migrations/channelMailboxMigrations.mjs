// Additive migration: original messages and delivery receipts remain authoritative.
export function migrateChannelMailbox({ db, ensureColumn }) {
  ensureColumn("session_collaboration_messages", "delivery_intent", "TEXT NOT NULL DEFAULT 'action_required'");
  db.run(`CREATE TABLE IF NOT EXISTS session_collaboration_message_order (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE REFERENCES session_collaboration_messages(message_id) ON DELETE CASCADE
  )`);
  db.run(`INSERT OR IGNORE INTO session_collaboration_message_order(message_id)
    SELECT message_id FROM session_collaboration_messages ORDER BY created_at, message_id`);
  db.run(`CREATE TRIGGER IF NOT EXISTS session_channel_message_sequence
    AFTER INSERT ON session_collaboration_messages BEGIN
      INSERT INTO session_collaboration_message_order(message_id) VALUES(NEW.message_id);
    END`);
  db.run(`CREATE TABLE IF NOT EXISTS session_collaboration_batches (
    batch_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE REFERENCES agent_operations(task_id),
    channel_id TEXT NOT NULL REFERENCES session_collaboration_channels(channel_id),
    recipient_session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','accepted','unknown','failed')),
    target_turn_id TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS session_collaboration_batch_items (
    batch_id TEXT NOT NULL REFERENCES session_collaboration_batches(batch_id),
    delivery_id TEXT NOT NULL UNIQUE REFERENCES session_collaboration_deliveries(delivery_id),
    batch_order INTEGER NOT NULL,
    PRIMARY KEY(batch_id, batch_order)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_session_channel_mailbox
    ON session_collaboration_deliveries(recipient_session_id, status, created_at)`);
}
