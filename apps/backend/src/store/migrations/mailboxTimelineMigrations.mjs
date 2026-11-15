import { isMailboxTimelineInput } from "../../application/mailboxTimelinePolicy.mjs";
import { TimelineMutationRepository } from "../repositories/timelineMutationRepository.mjs";

// Projection-only upgrade: originals, delivery receipts and Turns stay intact.
// The existing delete triggers generate revisions for every connected client.
export function migrateMailboxTimeline({ db, selectAll, selectOne, runDataMigrationOnce }) {
  runDataMigrationOnce("mailbox-inputs-outside-conversation-v2", () => {
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
  if (!selectOne("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coordination_requests'")) return;
  runDataMigrationOnce("coordination-host-receipts-v1", () => {
    const timeline = new TimelineMutationRepository({getDatabase:()=>db,selectAll,selectOne,scheduleSave(){},notifyTimelineDirty(){}});
    let cursor=0;
    while(true){
      const rows=selectAll(`SELECT i.rowid AS cursor,i.*,r.request_id,r.dispatch_json FROM session_items i
        JOIN coordination_requests r ON r.response_item_id=i.id
        WHERE i.rowid>? AND i.id=r.request_id||':reply' AND json_valid(r.dispatch_json)
        AND json_array_length(r.dispatch_json)>0 ORDER BY i.rowid LIMIT 100`,[cursor]);
      if(!rows.length)break;
      for(const row of rows){
        cursor=row.cursor;
        let raw;try{raw=JSON.parse(row.raw_metadata_json??'{}');}catch{continue;}
        if(raw.executionMode!=="coordination-request")continue;
        const dispatches=JSON.parse(row.dispatch_json);
        const ids=dispatches.map(d=>d.dispatchId).filter(Boolean);
        const batches=ids.length ? selectAll(`SELECT DISTINCT progress_batch_id FROM task_coordination_dispatches
          WHERE dispatch_id IN (${ids.map(()=>'?').join(',')}) AND progress_batch_id IS NOT NULL`,ids) : [];
        const batchId=batches.length===1 ? batches[0].progress_batch_id : null;
        if(batchId && selectOne("SELECT 1 FROM session_items WHERE session_id=? AND id=?",[row.session_id,`coordination-progress:${batchId}`])) {
          timeline.removeItem(row.session_id,row.id);
        } else {
          timeline.upsertTimelineItemProjection(row.session_id,{id:row.id,turnId:row.turn_id,type:row.type,
            text:`已受理 ${dispatches.length} 项指令。`,status:row.status,turnStatus:row.turn_status,createdAt:row.created_at,
            rawMetadataJSON:JSON.stringify({...raw,coordinationEvent:{kind:"receipt",batchId}})});
        }
      }
    }
  });

}
