import { parseJson } from "./storedJson.mjs";

export function reconcileInterruptedSessionExecutionAtStartup({ selectOne, runInTransaction, db, scheduleSave }, timestamp = new Date().toISOString()) {
  const counts = {
    tasks: Number(selectOne(
      "SELECT COUNT(*) AS count FROM agent_operations WHERE status IN ('queued','running')"
    )?.count ?? 0),
    deliveries: Number(selectOne(
      `SELECT COUNT(*) AS count FROM message_deliveries
       WHERE status IN ('queued','dispatching','accepted','processing','delivery_unknown')`
    )?.count ?? 0),
    collaborationDeliveries: Number(selectOne(
      `SELECT COUNT(*) AS count FROM collaboration_deliveries
       WHERE status IN ('pending','queued','delivering')`
    )?.count ?? 0),
    sessionCollaborationDeliveries: Number(selectOne(
      `SELECT COUNT(*) AS count FROM session_collaboration_deliveries
       WHERE status IN ('pending','queued','delivering')`
    )?.count ?? 0),
    turns: Number(selectOne(
      "SELECT COUNT(*) AS count FROM session_turns WHERE execution_status IN ('idle','running','blocked')"
    )?.count ?? 0)
  };
  if (Object.values(counts).every((count) => count === 0)) return counts;
  const interruption = "Execution interrupted by application restart; the message was not resent.";
  runInTransaction(() => {
    db.run(
      `UPDATE agent_operations
       SET status='failed', completed_at=COALESCE(completed_at, ?),
           last_error=COALESCE(last_error, ?), updated_at=?
       WHERE status IN ('queued','running')`,
      [timestamp, interruption, timestamp]
    );
    db.run(
      `UPDATE message_deliveries
       SET status='failed', last_error=COALESCE(last_error, ?), updated_at=?
       WHERE status IN ('queued','dispatching','accepted','processing','delivery_unknown')`,
      [interruption, timestamp]
    );
    // Collaboration delivery scanners deliberately retry ordinary failures.
    // A process-restart interruption is terminal, so exhaust its retry budget
    // while retaining the durable delivery record for history and diagnosis.
    db.run(
      `UPDATE collaboration_deliveries
       SET status='failed', attempt_count=2147483647, next_attempt_at=NULL,
           last_error=?, updated_at=?
       WHERE status IN ('pending','queued','delivering')`,
      [interruption, timestamp]
    );
    db.run(
      `UPDATE session_collaboration_deliveries
       SET status='failed', attempt_count=2147483647, next_attempt_at=NULL,
           last_error=?, updated_at=?
       WHERE status IN ('pending','queued','delivering')`,
      [interruption, timestamp]
    );
    db.run(
      `UPDATE session_items SET status='failed'
       WHERE id IN (
         SELECT message_id FROM message_deliveries
         WHERE status='failed' AND updated_at=?
       )`,
      [timestamp]
    );
    db.run(
      `UPDATE session_turns
       SET execution_status='cancelled', ended_at=COALESCE(ended_at, ?),
           failure_json=COALESCE(failure_json, ?), updated_at=?
       WHERE execution_status IN ('idle','running','blocked')`,
      [timestamp, JSON.stringify({ code: "PROCESS_RESTART_INTERRUPTED", message: interruption }), timestamp]
    );
    db.run(
      `UPDATE sessions
       SET status='cancelled', progress=1, active_choice_json=NULL,
           raw_json=json_set(raw_json, '$.activeTurnId', NULL, '$.activityStatus', NULL),
           updated_at=?
       WHERE status IN ('running','blocked')`,
      [timestamp]
    );
  });
  scheduleSave();
  return counts;
}

export function repairRegressedTerminalSessionTurns({ selectAll, selectOne, db, listUnsettledSessionTurns }) {
  const terminalStatus = {
    "turn.completed": "completed",
    "turn.failed": "failed",
    "turn.cancelled": "cancelled"
  };
  const activeTurns = selectAll(
    `SELECT session_id, binding_id, turn_id
     FROM session_turns
     WHERE execution_status IN ('idle', 'running', 'blocked')`
  );
  if (activeTurns.length === 0) return 0;

  const hasTerminalTurnIndex = Boolean(selectOne(
    `SELECT 1 FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_provider_event_inbox_terminal_turn'`
  ));
  const terminalEvents = hasTerminalTurnIndex
    ? selectAll(
      `SELECT turns.session_id, turns.binding_id, turns.turn_id,
              inbox.event_type, inbox.occurred_at, inbox.received_at,
              inbox.provider_event_id
       FROM session_turns turns
       JOIN provider_event_inbox inbox
         ON inbox.rowid = (
           SELECT terminal.rowid
           FROM provider_event_inbox terminal
           WHERE terminal.binding_id = turns.binding_id
             AND terminal.turn_id = turns.turn_id
             AND terminal.status = 'applied'
             AND terminal.event_type IN ('turn.completed', 'turn.failed', 'turn.cancelled')
           ORDER BY terminal.received_at DESC, terminal.provider_event_id DESC
           LIMIT 1
         )
       WHERE turns.execution_status IN ('idle', 'running', 'blocked')`
    )
    : activeTurns.flatMap((turn) => {
      // Older databases do not have the terminal-turn partial index. Building
      // it synchronously scans the large payload table before the HTTP server
      // can listen. The regression being repaired is caused by an item event
      // arriving immediately after a terminal event, so inspect only the
      // bounded tail of this exact Provider binding during the one-time
      // compatibility path.
      const event = selectOne(
        `SELECT event_type, occurred_at, received_at, provider_event_id
         FROM (
           SELECT rowid, turn_id, event_type, occurred_at, received_at,
                  provider_event_id, status
           FROM provider_event_inbox INDEXED BY idx_provider_event_inbox_binding_sequence
           WHERE binding_id = ?
           ORDER BY provider_sequence DESC, rowid DESC
           LIMIT 512
         ) recent
         WHERE turn_id = ?
           AND status = 'applied'
           AND event_type IN ('turn.completed', 'turn.failed', 'turn.cancelled')
         ORDER BY received_at DESC, provider_event_id DESC
         LIMIT 1`,
        [turn.binding_id, turn.turn_id]
      );
      return event ? [{ ...turn, ...event }] : [];
    });
  const repairedSessions = new Set();
  const repairedTurns = new Set();
  for (const event of terminalEvents) {
    const key = `${event.session_id}\u0000${event.binding_id}\u0000${event.turn_id}`;
    if (repairedTurns.has(key)) continue;
    repairedTurns.add(key);
    const settledAt = event.occurred_at ?? event.received_at;
    db.run(
      `UPDATE session_turns
       SET execution_status = ?, ended_at = COALESCE(ended_at, ?),
           updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
       WHERE session_id = ? AND binding_id = ? AND turn_id = ?
         AND execution_status IN ('idle', 'running', 'blocked')`,
      [
        terminalStatus[event.event_type], settledAt, event.received_at, event.received_at,
        event.session_id, event.binding_id, event.turn_id
      ]
    );
    if (db.getRowsModified() > 0) repairedSessions.add(event.session_id);
  }

  for (const sessionId of repairedSessions) {
    if (listUnsettledSessionTurns(sessionId).length > 0) continue;
    const session = selectOne("SELECT status, raw_json FROM sessions WHERE id = ?", [sessionId]);
    if (!session || !["running", "blocked"].includes(session.status)) continue;
    const latest = selectOne(
      `SELECT turn_id, execution_status FROM session_turns
       WHERE session_id = ? AND execution_status IN ('completed', 'failed', 'cancelled')
       ORDER BY COALESCE(ended_at, updated_at) DESC, turn_id DESC LIMIT 1`,
      [sessionId]
    );
    if (!latest) continue;
    const rawStatus = parseJson(session.raw_json, {});
    rawStatus.activeTurnId = null;
    rawStatus.activityStatus = null;
    rawStatus.lastSettledTurnId = latest.turn_id;
    if (rawStatus.capabilities && typeof rawStatus.capabilities === "object") {
      rawStatus.capabilities.canInterrupt = false;
    }
    db.run(
      "UPDATE sessions SET status = ?, progress = 1, raw_json = ? WHERE id = ?",
      [latest.execution_status === "completed" ? "complete" : latest.execution_status, JSON.stringify(rawStatus), sessionId]
    );
  }
  return repairedTurns.size;
}
