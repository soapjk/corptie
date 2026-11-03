import { isMailboxTimelineInput } from "../../application/mailboxTimelinePolicy.mjs";
import { TimelineMutationRepository } from "../repositories/timelineMutationRepository.mjs";

// Projection-only upgrade: originals, delivery receipts and Turns stay intact.
// The existing delete triggers generate revisions for every connected client.
export function migrateMailboxTimeline({ db, selectAll, selectOne, runDataMigrationOnce }) {
  runDataMigrationOnce("mailbox-inputs-outside-conversation-v1", () => {
    const timeline = new TimelineMutationRepository({ getDatabase: () => db, selectAll, selectOne,
      scheduleSave() {}, notifyTimelineDirty() {} });
    let cursor = 0;
    while (true) {
      const rows = selectAll(`SELECT rowid AS cursor,session_id,id,type,raw_metadata_json
        FROM session_items WHERE rowid>? AND type IN ('userMessage','automationEvent')
        ORDER BY rowid LIMIT 500`, [cursor]);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.cursor;
        if (isMailboxTimelineInput({ id: row.id, type: row.type, sessionId: row.session_id,
          rawMetadataJSON: row.raw_metadata_json }, selectOne)) timeline.removeItem(row.session_id, row.id);
      }
    }
  });
}
