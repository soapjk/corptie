import { agentMessageEventSQL, conversationActivityEventSQL } from "../sessionEventSemantics.mjs";

export function migrateSessionEventStorage({ ensureColumn, migrateSessionEventAgentMessageFlag, db, migrateCanonicalCompletionAgentMessageFlag, runDataMigrationOnce, hadSessionReadReceipts }) {
    // --- 会话日志事件溯源（10）：补 session_logs + session_events 语义列 ---
    ensureColumn("session_events", "log_id", "TEXT");
    ensureColumn("session_events", "producer", "TEXT");
    ensureColumn("session_events", "surface", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("session_events", "source_event_seqs_json", "TEXT");
    ensureColumn("session_events", "call_id", "TEXT");
    ensureColumn("session_events", "has_agent_message", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("session_events", "storage_version", "INTEGER NOT NULL DEFAULT 1");
    migrateSessionEventAgentMessageFlag();
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_events_canonical_completion
      ON session_events(session_id, sequence)
      WHERE type = 'turn.completed'
    `);
    migrateCanonicalCompletionAgentMessageFlag();
    db.run("CREATE INDEX IF NOT EXISTS idx_session_events_producer ON session_events(session_id, producer)");
    db.run("CREATE INDEX IF NOT EXISTS idx_session_events_call_id ON session_events(session_id, call_id)");
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_events_conversation_activity
      ON session_events(session_id, created_at DESC)
      WHERE ${conversationActivityEventSQL()}
    `);
    db.run("DROP INDEX IF EXISTS idx_session_events_latest_message");
    runDataMigrationOnce("session-events-agent-message-index-v1", () => {
      db.run("DROP INDEX IF EXISTS idx_session_events_agent_message");
      db.run(`
        CREATE INDEX idx_session_events_agent_message
        ON session_events(session_id, sequence DESC)
        WHERE has_agent_message = 1
      `);
    });
    // 回填：为每个已有 session 建立 1:1 的 session_log；并让既有事件指向该 log。
    db.run(`
      INSERT INTO session_logs (id, session_id, created_at)
      SELECT 'log:' || id, id, COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      FROM sessions
      WHERE NOT EXISTS (SELECT 1 FROM session_logs WHERE session_logs.session_id = sessions.id)
    `);
    runDataMigrationOnce("session-events-log-id-backfill-v1", () => {
      db.run(`
        UPDATE session_events
        SET log_id = 'log:' || session_id
        WHERE log_id IS NULL
      `);
    });
    // Introducing server-side receipts must not make every historical Session
    // unread at once. Bootstrap only when the table is first created; future
    // Sessions deliberately have no receipt until the user opens their detail.
    if (!hadSessionReadReceipts) {
      db.run(`
        INSERT OR IGNORE INTO session_read_receipts (
          session_id, last_read_agent_message_sequence, updated_at
        )
        SELECT sessions.id, COALESCE(MAX(session_events.sequence), 0),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM sessions
        LEFT JOIN session_events ON session_events.session_id = sessions.id
          AND ${agentMessageEventSQL("session_events")}
        GROUP BY sessions.id
      `);
    }
}
