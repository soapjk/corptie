import { automationTimelineItems } from "../../utils/sessionEventPresentation.mjs";
import { sessionEventFromRow } from "../sessionEventRow.mjs";
import { TimelineMutationRepository } from "../repositories/timelineMutationRepository.mjs";

// Startup-only materialized projection upgrade. Never replay execution or fetch
// Provider history; page durable events so memory is bounded independently of history.
export function migrateAutomationTimelineV2({ db, selectAll, selectOne, runDataMigrationOnce }) {
  runDataMigrationOnce("automation-run-timeline-v2", () => {
    const timeline = new TimelineMutationRepository({ getDatabase: () => db, selectOne, selectAll,
      scheduleSave() {}, notifyTimelineDirty() {} });
    let cursor = 0;
    while (true) {
      const rows = selectAll(`SELECT e.rowid AS cursor, e.* FROM session_events e
        JOIN sessions s ON s.id=e.session_id WHERE e.rowid>? AND e.type LIKE 'ScheduledSession%'
        AND s.deleted_at IS NULL ORDER BY e.rowid LIMIT 500`, [cursor]);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.cursor;
        const event = sessionEventFromRow(row);
        for (const item of automationTimelineItems([event], { resolveRun(id) {
          const run = selectOne("SELECT * FROM scheduled_session_runs WHERE run_id=?", [id]);
          return run ? { ...event.payload.run, runId: id, status: run.status,
            createdAt: run.created_at, scheduledFor: run.scheduled_for } : null;
        } })) {
          if (!item.automationRunId) continue;
          const prior = selectOne("SELECT raw_metadata_json FROM session_items WHERE session_id=? AND id=?", [row.session_id, item.id]);
          if (prior) {
            try { item.automationName = JSON.parse(prior.raw_metadata_json).automationName; } catch {}
          }
          timeline.upsertTimelineItemProjection(row.session_id, { ...item, rawMetadataJSON: JSON.stringify(item) });
          timeline.removeItem(row.session_id, `automation-event:${event.eventId}`);
        }
      }
    }
    cursor = 0;
    while (true) {
      const rows = selectAll(`SELECT rowid AS cursor, * FROM agent_operations WHERE rowid>?
        AND kind='user' AND json_extract(source_json,'$.type')='scheduled_session_task'
        ORDER BY rowid LIMIT 500`, [cursor]);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.cursor;
        const source = JSON.parse(row.source_json);
        db.run(`UPDATE session_items SET raw_metadata_json=json_set(
          CASE WHEN json_valid(raw_metadata_json) THEN raw_metadata_json ELSE '{}' END,
          '$.messageOrigin','scheduled_task','$.automationRunId',?,'$.automationId',?,'$.automationName',?)
          WHERE session_id=? AND id=? AND type='userMessage'`,
          [source.scheduledRunId ?? null, source.automationId ?? source.scheduledTaskId ?? null,
            source.automationName ?? null, row.session_id, source.messageId ?? row.task_id]);
      }
    }
  });
}
