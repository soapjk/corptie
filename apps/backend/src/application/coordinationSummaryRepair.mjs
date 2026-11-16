import { setImmediate as yieldToLoop } from "node:timers/promises";
import { coordinationMessageMetadata, coordinationSummaryBody } from "../utils/coordinationMessageMetadata.mjs";

// Finite startup repair, not a watcher or a transcript scan. Seek the reports
// primary key in small pages, then the exact Session+batch item-key range.
// Remove only product-owned copies whose canonical report still holds the
// identical body; user/Provider messages and different historical facts stay.
export async function repairDuplicateCoordinationSummaries(store) {
  let after = "", removed = 0;
  while (store.db) {
    const reports = store.selectAll(`SELECT report_id,main_session_id,body FROM coordination_shadow_reports
      WHERE report_id>? ORDER BY report_id LIMIT 100`, [after]);
    if (!reports.length) break;
    for (const report of reports) {
      const route = store.getLogicalSession(report.main_session_id);
      if (!route?.legacySessionId) continue;
      const canonical = store.getSessionItem(route.legacySessionId, report.report_id);
      const metadata = canonical && coordinationMessageMetadata(canonical.rawMetadataJSON);
      const batchId = canonical?.coordinationEvent?.batchId ?? metadata?.coordinationEvent?.batchId ?? metadata?.progressBatchId;
      if (!batchId || canonical.type !== "agentMessage" || coordinationSummaryBody(canonical.text) !== report.body) continue;
      const prefix = `coordination-summary:${batchId}:`;
      const copies = store.selectAll(`SELECT id,text FROM session_items
        WHERE session_id=? AND id GLOB ? AND type='agentMessage'`, [route.legacySessionId, `${prefix}*`]);
      for (const copy of copies) {
        if (copy.id.slice(prefix.length).match(/^\d+$/) && copy.text === report.body) {
          store.removeItem(route.legacySessionId, copy.id); removed++;
        }
      }
    }
    after = reports.at(-1).report_id;
    if (reports.length < 100) break;
    await yieldToLoop();
  }
  return { removed };
}
