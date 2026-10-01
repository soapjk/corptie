import { sessionEventFromRow } from "../sessionEventRow.mjs";
import { surfaceForEventType, agentMessageEventSQL, conversationActivityEventSQL, eventHasAgentMessage, producerFromSource } from "../sessionEventSemantics.mjs";

export class SessionEventRepository {
  constructor({ getDatabase, normalizedSessionIdFilter, selectOne, selectAll, runInTransaction, scheduleSave, getSession }) {
    this.getDatabase = getDatabase;
    this.normalizedSessionIdFilter = normalizedSessionIdFilter;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.runInTransaction = runInTransaction;
    this.scheduleSave = scheduleSave;
    this.getSession = getSession;
  }

  get db() {
    return this.getDatabase();
  }

  hasSessionEvent(eventId) {
    const normalizedEventId = String(eventId || "").trim();
    if (!normalizedEventId) return false;
    return Boolean(this.selectOne(
      "SELECT 1 FROM session_events WHERE event_id = ?",
      [normalizedEventId]
    ));
  }

  appendSessionEvent(event) {
    const sessionId = String(event.sessionId || "").trim();
    if (!sessionId) {
      return null;
    }
    const surface = event.surface == null
      ? surfaceForEventType(event.type)
      : (event.surface ? 1 : 0);
    const sourceEventSeqs = event.sourceEventSeqs ?? null;
    const callId = event.callId ?? null;
    const producer = event.producer ?? producerFromSource(event.source);

    // The outer Provider ingestion transaction, when present, owns commit and
    // rollback. Standalone callers still receive one BEGIN IMMEDIATE here.
    const appended = this.runInTransaction(() => {
      this.ensureSessionLog(sessionId);
      const existing = this.selectOne(
        "SELECT 1 FROM session_events WHERE event_id = ?",
        [event.eventId]
      );
      if (existing) {
        throw new Error(`Duplicate event_id: ${event.eventId}`);
      }
      const row = this.selectOne(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
        [sessionId]
      );
      const sequence = Number(row?.sequence ?? 0) + 1;
      this.db.run(
        `INSERT INTO session_events (
          event_id, session_id, log_id, sequence, type, producer, surface,
          source_event_seqs_json, call_id, source_json, payload_json, storage_version,
          has_agent_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.eventId,
          sessionId,
          `log:${sessionId}`,
          sequence,
          event.type,
          producer,
          surface,
          sourceEventSeqs ? JSON.stringify(sourceEventSeqs) : null,
          callId,
          event.source ? JSON.stringify(event.source) : null,
          JSON.stringify(event.payload ?? {}),
          Math.max(1, Number(event.storageVersion) || 1),
          eventHasAgentMessage(event) ? 1 : 0,
          event.createdAt || new Date().toISOString()
        ]
      );
      this.scheduleSave();
      return {
        ...event,
        sessionId,
        logId: `log:${sessionId}`,
        sequence,
        producer,
        surface: surface === 1,
        sourceEventSeqs,
        callId
      };
    });
    return appended;
  }

  ensureSessionLog(sessionId) {
    this.db.run(
      `INSERT INTO session_logs (id, session_id, created_at)
       SELECT 'log:' || ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE NOT EXISTS (SELECT 1 FROM session_logs WHERE session_logs.session_id = ?)`,
      [sessionId, sessionId, sessionId]
    );
  }

  listSessionEvents(sessionId, after = 0, limit = 200) {
    const rows = this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM session_events
       WHERE session_id = ? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`,
      [sessionId, Math.max(0, Number(after) || 0), Math.max(1, Math.min(1000, Number(limit) || 200))]
    );
    return rows.map(sessionEventFromRow);
  }

  listSessionAutomationEvents(sessionId, limit = 200) {
    const rows = this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM (
         SELECT event_id, session_id, log_id, sequence, type, producer, surface,
                source_event_seqs_json, call_id, source_json, payload_json, created_at
         FROM session_events
         WHERE session_id = ?
           AND (type LIKE 'ScheduledSession%' OR type LIKE 'Automation%')
         ORDER BY sequence DESC LIMIT ?
       ) ORDER BY sequence ASC`,
      [sessionId, Math.max(1, Math.min(500, Number(limit) || 200))]
    );
    return rows.map(sessionEventFromRow);
  }

  listSessionEventPage(sessionId, { beforeSequence = null, limit = 200 } = {}) {
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const before = Number(beforeSequence);
    const hasBefore = Number.isSafeInteger(before) && before > 0;
    const rows = this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM (
         SELECT event_id, session_id, log_id, sequence, type, producer, surface,
                source_event_seqs_json, call_id, source_json, payload_json, created_at
         FROM session_events
         WHERE session_id = ? ${hasBefore ? "AND sequence < ?" : ""}
         ORDER BY sequence DESC LIMIT ?
       )
       ORDER BY sequence ASC`,
      hasBefore ? [sessionId, before, pageLimit] : [sessionId, pageLimit]
    );
    return rows.map(sessionEventFromRow);
  }

  listLatestSessionMessageTimes(sessionIds = null) {
    const ids = this.normalizedSessionIdFilter(sessionIds);
    if (ids?.length === 0) return new Map();
    // SQLite has repeatedly preferred the much larger cursor index for this
    // sparse predicate when sqlite_stat1 is absent or stale. Resident callers
    // already supply authoritative, non-deleted Session ids, so keep that hot
    // path on the purpose-built partial index and avoid the redundant join.
    const rows = ids ? this.selectAll(
      `SELECT events.session_id, MAX(events.created_at) AS last_message_at
       FROM session_events events INDEXED BY idx_session_events_conversation_activity
       WHERE ${conversationActivityEventSQL("events")}
         AND events.session_id IN (${ids.map(() => "?").join(", ")})
       GROUP BY events.session_id`,
      ids
    ) : this.selectAll(
      `SELECT events.session_id, MAX(events.created_at) AS last_message_at
       FROM session_events events INDEXED BY idx_session_events_conversation_activity
       JOIN sessions ON sessions.id = events.session_id AND sessions.deleted_at IS NULL
       WHERE ${conversationActivityEventSQL("events")}
       GROUP BY events.session_id`
    );
    return new Map(rows.map((row) => [row.session_id, row.last_message_at]));
  }

  listSessionMessageCursors(sessionIds = null) {
    const ids = this.normalizedSessionIdFilter(sessionIds);
    if (ids?.length === 0) return new Map();
    const rows = ids ? this.selectAll(`
      SELECT sessions.id AS session_id,
             COALESCE((
               SELECT MAX(events.sequence) FROM session_events events
               WHERE events.session_id = sessions.id
                 AND ${agentMessageEventSQL("events")}
             ), 0) AS last_agent_message_sequence,
             COALESCE(session_read_receipts.last_read_agent_message_sequence, 0)
               AS last_read_message_sequence
      FROM sessions
      LEFT JOIN session_read_receipts ON session_read_receipts.session_id = sessions.id
      WHERE sessions.deleted_at IS NULL
        AND sessions.id IN (${ids.map(() => "?").join(", ")})
    `, ids) : this.selectAll(`
      SELECT sessions.id AS session_id,
             COALESCE(agent_messages.last_agent_message_sequence, 0)
               AS last_agent_message_sequence,
             COALESCE(session_read_receipts.last_read_agent_message_sequence, 0)
               AS last_read_message_sequence
      FROM sessions
      LEFT JOIN (
        SELECT session_id, MAX(sequence) AS last_agent_message_sequence
        FROM session_events
        WHERE ${agentMessageEventSQL("session_events")}
        GROUP BY session_id
      ) AS agent_messages ON agent_messages.session_id = sessions.id
      LEFT JOIN session_read_receipts ON session_read_receipts.session_id = sessions.id
      WHERE sessions.deleted_at IS NULL
    `);
    return new Map(rows.map((row) => [row.session_id, {
      lastAgentMessageSequence: Number(row.last_agent_message_sequence ?? 0),
      lastReadMessageSequence: Number(row.last_read_message_sequence ?? 0)
    }]));
  }



  lastAgentMessageSequence(sessionId) {
    const row = this.selectOne(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM session_events
      WHERE session_id = ? AND ${agentMessageEventSQL("session_events")}
    `, [sessionId]);
    return Number(row?.sequence ?? 0);
  }

  markSessionMessagesRead(sessionId, throughSequence) {
    if (!this.getSession(sessionId)) {
      const error = new Error("Session not found.");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const latest = this.lastAgentMessageSequence(sessionId);
    const through = Number(throughSequence);
    if (!Number.isSafeInteger(through) || through < 0 || through > latest) {
      const error = new Error(`Invalid read sequence: expected an integer from 0 through ${latest}.`);
      error.code = "INVALID_READ_SEQUENCE";
      throw error;
    }
    const existing = this.selectOne(
      "SELECT last_read_agent_message_sequence FROM session_read_receipts WHERE session_id = ?",
      [sessionId]
    );
    const alreadyRead = Number(existing?.last_read_agent_message_sequence ?? 0);
    if (alreadyRead >= through) {
      return {
        lastAgentMessageSequence: latest,
        lastReadMessageSequence: alreadyRead
      };
    }
    const timestamp = new Date().toISOString();
    this.db.run(`
      INSERT INTO session_read_receipts (
        session_id, last_read_agent_message_sequence, updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_read_agent_message_sequence = MAX(
          session_read_receipts.last_read_agent_message_sequence,
          excluded.last_read_agent_message_sequence
        ),
        updated_at = CASE
          WHEN excluded.last_read_agent_message_sequence > session_read_receipts.last_read_agent_message_sequence
          THEN excluded.updated_at ELSE session_read_receipts.updated_at END
    `, [sessionId, through, timestamp]);
    this.scheduleSave();
    return this.listSessionMessageCursors().get(sessionId);
  }

  lastSessionEventSequence(sessionId) {
    const row = this.selectOne(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
      [sessionId]
    );
    return Number(row?.sequence ?? 0);
  }



  getSessionEventByIdentity(sessionId, eventId, sequence) {
    const row = this.selectOne(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM session_events WHERE session_id = ? AND event_id = ? AND sequence = ?`,
      [sessionId, eventId, Number(sequence)]
    );
    return row ? sessionEventFromRow(row) : null;
  }

  getSessionEvent(eventId) {
    const row = this.selectOne(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM session_events WHERE event_id = ?`,
      [eventId]
    );
    return row ? sessionEventFromRow(row) : null;
  }
}
