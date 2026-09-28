import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

export function migrateSessionEventAgentMessageFlag({ db, selectOne, runInTransaction }) {
  const migrationId = "session-events-has-agent-message-v1";
  if (selectOne("SELECT migration_id FROM data_migrations WHERE migration_id = ?", [migrationId])) {
    return;
  }
  runInTransaction(() => {
    db.run(`
      UPDATE session_events
      SET has_agent_message = CASE
        WHEN type IN ('CodexThreadCompleted', 'AgentTurnCompleted')
         AND COALESCE(json_extract(payload_json, '$.hasAgentMessage'), 0) = 1
        THEN 1 ELSE 0 END
    `);
    db.run(
      "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
      [migrationId, createdAtFromOrNow()]
    );
  });
}

export function migrateCanonicalCompletionAgentMessageFlag({ db, selectOne, runDataMigrationOnce, recordAudit }) {
  runDataMigrationOnce("session-events-canonical-agent-message-v2", () => {
    // The Provider-neutral event pipeline originally wrote turn.completed
    // while the cursor classifier still recognized only legacy completion
    // types. Repair those rows, but establish the repaired history as read:
    // there is no durable evidence telling which replies were viewed during
    // the incident, and surfacing all of them would create stale alerts.
    const scanned = selectOne(`
      SELECT COUNT(*) AS scanned_events
      FROM session_events
      WHERE type = 'turn.completed'
    `);
    const audit = selectOne(`
      SELECT COUNT(*) AS repaired_events,
             COUNT(DISTINCT session_id) AS affected_sessions
      FROM session_events
      WHERE type = 'turn.completed'
        AND ${canonicalAgentMessagePayloadSQL("session_events")}
    `);
    const receiptAudit = selectOne(`
      SELECT COUNT(*) AS adjusted_receipts
      FROM (
        SELECT events.session_id, MAX(events.sequence) AS repaired_sequence,
               COALESCE(receipts.last_read_agent_message_sequence, 0) AS previous_sequence
        FROM session_events events
        JOIN sessions ON sessions.id = events.session_id
        LEFT JOIN session_read_receipts receipts ON receipts.session_id = events.session_id
        WHERE events.type = 'turn.completed'
          AND ${canonicalAgentMessagePayloadSQL("events")}
        GROUP BY events.session_id
      )
      WHERE repaired_sequence > previous_sequence
    `);
    db.run(`
      INSERT INTO session_read_receipts (
        session_id, last_read_agent_message_sequence, updated_at
      )
      SELECT events.session_id, MAX(events.sequence), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM session_events events
      JOIN sessions ON sessions.id = events.session_id
      WHERE events.type = 'turn.completed'
        AND ${canonicalAgentMessagePayloadSQL("events")}
      GROUP BY events.session_id
      ON CONFLICT(session_id) DO UPDATE SET
        last_read_agent_message_sequence = MAX(
          session_read_receipts.last_read_agent_message_sequence,
          excluded.last_read_agent_message_sequence
        ),
        updated_at = CASE
          WHEN excluded.last_read_agent_message_sequence
            > session_read_receipts.last_read_agent_message_sequence
          THEN excluded.updated_at ELSE session_read_receipts.updated_at END
    `);
    db.run(`
      UPDATE session_events
      SET has_agent_message = 1
      WHERE type = 'turn.completed'
        AND has_agent_message = 0
        AND ${canonicalAgentMessagePayloadSQL("session_events")}
    `);
    const canonicalUnreadMigrationAudit = {
      scannedEvents: Number(scanned?.scanned_events ?? 0),
      repairedEvents: Number(audit?.repaired_events ?? 0),
      affectedSessions: Number(audit?.affected_sessions ?? 0),
      adjustedReceipts: Number(receiptAudit?.adjusted_receipts ?? 0)
    };
    recordAudit(canonicalUnreadMigrationAudit);
    if (canonicalUnreadMigrationAudit.scannedEvents > 0) {
      console.log(`[migration] session-events-canonical-agent-message-v2 ${JSON.stringify(canonicalUnreadMigrationAudit)}`);
    }
  });
}

function canonicalAgentMessagePayloadSQL(tableAlias) {
  return `(
    COALESCE(json_extract(${tableAlias}.payload_json, '$.hasAgentMessage'), 0) = 1
    OR EXISTS (
      SELECT 1 FROM json_each(${tableAlias}.payload_json, '$.items') AS item
      WHERE json_extract(item.value, '$.turnId')
              = json_extract(${tableAlias}.payload_json, '$.turnId')
        AND json_extract(item.value, '$.type') = 'agentMessage'
        AND json_extract(item.value, '$.presentationRole') = 'final_answer'
        AND LENGTH(TRIM(COALESCE(json_extract(item.value, '$.text'), ''))) > 0
    )
  )`;
}
