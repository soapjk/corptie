export function migrateSessionMailbox({ db }) {
  db.run(`CREATE TABLE IF NOT EXISTS session_mailbox_settings (
    recipient_session_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_mailbox_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    recipient_session_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('channel','automation','background','system')),
    source_id TEXT NOT NULL,
    channel_delivery_id TEXT UNIQUE REFERENCES session_collaboration_deliveries(delivery_id),
    operation_id TEXT UNIQUE REFERENCES agent_operations(task_id),
    body TEXT,
    intent TEXT NOT NULL DEFAULT 'action_required',
    priority INTEGER NOT NULL DEFAULT 50,
    authorization_json TEXT NOT NULL DEFAULT '{}',
    disposition TEXT NOT NULL DEFAULT 'pending' CHECK(disposition IN ('pending','ignored','adopted','withdrawn')),
    manual_requested INTEGER NOT NULL DEFAULT 0,
    read_at TEXT,
    adopted_turn_id TEXT,
    adopted_binding_id TEXT,
    adopted_provider_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_mailbox_recipient
    ON session_mailbox_messages(recipient_session_id,sequence DESC);
  CREATE INDEX IF NOT EXISTS idx_session_mailbox_pending
    ON session_mailbox_messages(recipient_session_id,disposition,intent,sequence);
  CREATE TRIGGER IF NOT EXISTS session_mailbox_channel_received
    AFTER INSERT ON session_collaboration_deliveries BEGIN
      INSERT OR IGNORE INTO session_mailbox_messages
        (message_id,recipient_session_id,source_type,source_id,channel_delivery_id,intent,created_at,updated_at)
      SELECT 'mailbox:' || m.message_id,m.recipient_session_id,'channel',m.channel_id,NEW.delivery_id,
        m.delivery_intent,m.created_at,m.created_at FROM session_collaboration_messages m WHERE m.message_id=NEW.message_id;
    END;`);
  // One immutable original for Channel bodies; the mailbox is an index.
  db.run(`INSERT OR IGNORE INTO session_mailbox_messages
    (message_id,recipient_session_id,source_type,source_id,channel_delivery_id,intent,created_at,updated_at)
    SELECT 'mailbox:' || m.message_id,m.recipient_session_id,'channel',m.channel_id,d.delivery_id,
      m.delivery_intent,m.created_at,m.created_at FROM session_collaboration_messages m
    JOIN session_collaboration_deliveries d ON d.message_id=m.message_id ORDER BY m.created_at,m.message_id`);
}
