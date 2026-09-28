// Uses the caller-owned migration connection; no transaction or startup reordering.
export function ensureProviderEventPipelineTables({ db, ensureColumn }) {
  db.run(`
    CREATE TABLE IF NOT EXISTS provider_event_inbox (
      provider_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      logical_session_id TEXT,
      session_id TEXT,
      routing_version INTEGER NOT NULL,
      provider_sequence INTEGER,
      turn_id TEXT,
      item_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT,
      received_at TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      normalized_event_json TEXT NOT NULL,
      event_fingerprint TEXT,
      status TEXT NOT NULL CHECK (status IN ('received', 'applied', 'quarantined', 'failed')),
      failure_code TEXT,
      failure_message TEXT,
      applied_at TEXT,
      PRIMARY KEY (provider_id, provider_session_id, provider_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_event_inbox_binding_sequence
    ON provider_event_inbox(binding_id, provider_sequence);
    CREATE INDEX IF NOT EXISTS idx_provider_event_inbox_status
    ON provider_event_inbox(status, received_at);

    CREATE TABLE IF NOT EXISTS provider_binding_cursors (
      binding_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      routing_version INTEGER NOT NULL,
      last_provider_sequence INTEGER,
      last_provider_event_id TEXT,
      resume_token TEXT,
      connection_status TEXT NOT NULL DEFAULT 'disconnected'
        CHECK (connection_status IN ('connected', 'reconnecting', 'disconnected')),
      sync_health TEXT NOT NULL DEFAULT 'healthy'
        CHECK (sync_health IN ('healthy', 'gap', 'degraded')),
      gap_expected_sequence INTEGER,
      gap_received_sequence INTEGER,
      last_connected_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_turns (
      session_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      routing_version INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      execution_status TEXT NOT NULL
        CHECK (execution_status IN ('idle', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
      final_item_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      last_provider_sequence INTEGER,
      failure_json TEXT,
      sync_health TEXT NOT NULL DEFAULT 'healthy'
        CHECK (sync_health IN ('healthy', 'gap', 'degraded')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, binding_id, turn_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_turns_active
    ON session_turns(session_id, execution_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_turns_repair_active
    ON session_turns(binding_id, turn_id, session_id)
    WHERE execution_status IN ('idle', 'running', 'blocked');

    CREATE TABLE IF NOT EXISTS event_outbox (
      outbox_id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      session_id TEXT,
      revision INTEGER,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'published', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_event_outbox_pending
    ON event_outbox(status, created_at);

    CREATE TABLE IF NOT EXISTS message_deliveries (
      delivery_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      routing_version INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'dispatching', 'accepted', 'processing', 'completed',
        'failed', 'cancelled', 'delivery_unknown'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      provider_turn_id TEXT,
      last_attempt_at TEXT,
      provider_acknowledged_at TEXT,
      last_error TEXT,
      source_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_message_deliveries_dispatch
    ON message_deliveries(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_message_deliveries_session
    ON message_deliveries(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_usage_snapshots (
      session_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model TEXT,
      context_json TEXT,
      account_json TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  ensureColumn("provider_event_inbox", "event_fingerprint", "TEXT");
  ensureColumn(
    "provider_binding_cursors",
    "connection_status",
    "TEXT NOT NULL DEFAULT 'disconnected' CHECK (connection_status IN ('connected', 'reconnecting', 'disconnected'))"
  );
}
