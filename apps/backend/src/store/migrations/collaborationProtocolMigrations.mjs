export function migrateCollaborationProtocol({ ensureColumn, db, migrateCanonicalSessionNames, migrateCollaborationSessionIdentities }) {
    ensureColumn("collaboration_requests", "initiator_session_id", "TEXT");
    ensureColumn("collaboration_requests", "recipient_session_id", "TEXT");
    ensureColumn("collaboration_requests", "initiator_name_at_send", "TEXT");
    ensureColumn("collaboration_requests", "recipient_name_at_send", "TEXT");
    ensureColumn("collaboration_requests", "routing_version", "INTEGER");
    ensureColumn("collaboration_requests", "route_status", "TEXT NOT NULL DEFAULT 'unresolved'");
    ensureColumn("collaboration_requests", "routing_intent", "TEXT");
    ensureColumn("collaboration_requests", "artifact_status", "TEXT NOT NULL DEFAULT 'pending'");
    ensureColumn("collaboration_requests", "acceptance_status", "TEXT NOT NULL DEFAULT 'pending'");
    ensureColumn("collaboration_requests", "initiator_binding_id", "TEXT");
    ensureColumn("collaboration_requests", "recipient_binding_id", "TEXT");
    ensureColumn("collaboration_requests", "protocol_version", "TEXT NOT NULL DEFAULT '1.0'");
    ensureColumn("collaboration_requests", "source_work_id", "TEXT");
    ensureColumn("collaboration_requests", "target_work_id", "TEXT");
    ensureColumn("collaboration_requests", "source_task_id", "TEXT");
    ensureColumn("collaboration_requests", "target_task_id", "TEXT");
    ensureColumn("collaboration_messages", "protocol_version", "TEXT NOT NULL DEFAULT '1.0'");
    ensureColumn("collaboration_messages", "source_work_id", "TEXT");
    ensureColumn("collaboration_messages", "target_work_id", "TEXT");
    ensureColumn("collaboration_messages", "source_task_id", "TEXT");
    ensureColumn("collaboration_messages", "target_task_id", "TEXT");
    ensureColumn("collaboration_messages", "payload_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("collaboration_messages", "error_json", "TEXT");
    ensureColumn("collaboration_messages", "sender_session_id", "TEXT");
    ensureColumn("collaboration_messages", "recipient_session_id", "TEXT");
    ensureColumn("collaboration_deliveries", "recipient_session_id", "TEXT");
    ensureColumn("collaboration_artifacts", "producer_session_id", "TEXT");
    ensureColumn("collaboration_events", "actor_session_id", "TEXT");
    db.run(`CREATE TABLE IF NOT EXISTS collaboration_session_participants (
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('initiator', 'recipient')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, session_id),
      UNIQUE (task_id, role),
      FOREIGN KEY (task_id) REFERENCES collaboration_requests(task_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collaboration_requests_session_inbox
      ON collaboration_requests(recipient_session_id, status, updated_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collaboration_requests_session_outbox
      ON collaboration_requests(initiator_session_id, status, updated_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collaboration_deliveries_session
      ON collaboration_deliveries(recipient_session_id, status, next_attempt_at, created_at ASC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collaboration_requests_work_task
      ON collaboration_requests(source_work_id, target_work_id, target_task_id, updated_at DESC)`);
    ensureColumn("collaboration_request_confirmations", "initiator_session_id", "TEXT");
    ensureColumn("collaboration_request_confirmations", "recipient_session_id", "TEXT");
    ensureColumn("collaboration_request_confirmations", "initiator_name_at_send", "TEXT");
    ensureColumn("collaboration_request_confirmations", "recipient_name_at_send", "TEXT");
    db.run(`CREATE INDEX IF NOT EXISTS idx_collaboration_request_confirmations_route
      ON collaboration_request_confirmations(
        initiator_session_id, recipient_session_id, status, resolved_at DESC
      )`);
    migrateCanonicalSessionNames();
    migrateCollaborationSessionIdentities();
    db.run(`UPDATE collaboration_deliveries
      SET recipient_session_id = (
        SELECT messages.recipient_session_id FROM collaboration_messages messages
        WHERE messages.message_id = collaboration_deliveries.message_id
      )
      WHERE recipient_session_id IS NULL`);
    db.run(`INSERT OR IGNORE INTO collaboration_session_participants (task_id, session_id, role, created_at)
      SELECT task_id, initiator_session_id, 'initiator', created_at
      FROM collaboration_requests WHERE initiator_session_id IS NOT NULL`);
    db.run(`INSERT OR IGNORE INTO collaboration_session_participants (task_id, session_id, role, created_at)
      SELECT task_id, recipient_session_id, 'recipient', created_at
      FROM collaboration_requests WHERE recipient_session_id IS NOT NULL
        AND recipient_session_id IS NOT initiator_session_id`);
    db.run(`CREATE TRIGGER IF NOT EXISTS collaboration_v3_task_sessions_required
      BEFORE INSERT ON collaboration_requests
      WHEN NEW.protocol_version = '3.0'
        AND (NEW.initiator_session_id IS NULL OR TRIM(NEW.initiator_session_id) = ''
          OR NEW.recipient_session_id IS NULL OR TRIM(NEW.recipient_session_id) = ''
          OR NEW.initiator_session_id = NEW.recipient_session_id)
      BEGIN SELECT RAISE(ABORT, 'COLLABORATION_V3_DISTINCT_SESSIONS_REQUIRED'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS collaboration_v3_task_session_updates_required
      BEFORE UPDATE OF protocol_version, initiator_session_id, recipient_session_id ON collaboration_requests
      WHEN NEW.protocol_version = '3.0'
        AND (NEW.initiator_session_id IS NULL OR TRIM(NEW.initiator_session_id) = ''
          OR NEW.recipient_session_id IS NULL OR TRIM(NEW.recipient_session_id) = ''
          OR NEW.initiator_session_id = NEW.recipient_session_id)
      BEGIN SELECT RAISE(ABORT, 'COLLABORATION_V3_DISTINCT_SESSIONS_REQUIRED'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS collaboration_v3_message_sessions_required
      BEFORE INSERT ON collaboration_messages
      WHEN NEW.protocol_version = '3.0'
        AND (NEW.sender_session_id IS NULL OR TRIM(NEW.sender_session_id) = ''
          OR NEW.recipient_session_id IS NULL OR TRIM(NEW.recipient_session_id) = ''
          OR NEW.sender_session_id = NEW.recipient_session_id)
      BEGIN SELECT RAISE(ABORT, 'COLLABORATION_V3_DISTINCT_MESSAGE_SESSIONS_REQUIRED'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS collaboration_v3_message_session_updates_required
      BEFORE UPDATE OF protocol_version, sender_session_id, recipient_session_id ON collaboration_messages
      WHEN NEW.protocol_version = '3.0'
        AND (NEW.sender_session_id IS NULL OR TRIM(NEW.sender_session_id) = ''
          OR NEW.recipient_session_id IS NULL OR TRIM(NEW.recipient_session_id) = ''
          OR NEW.sender_session_id = NEW.recipient_session_id)
      BEGIN SELECT RAISE(ABORT, 'COLLABORATION_V3_DISTINCT_MESSAGE_SESSIONS_REQUIRED'); END`);
}
