import { parentPort, workerData } from 'node:worker_threads';
import { NativeDatabase } from './nativeDatabase.mjs';
import { configureStoreDatabase } from './storeDatabaseConnection.mjs';

// Only idempotent reclamation of already retired coordination Sessions runs
// here. No Provider dispatch or user-message admission is retried by this lane.
const tables = new Set(['session_items','session_events','session_logs','provider_event_inbox','event_outbox',
  'message_deliveries','session_turns','session_execution_plan_state','session_memory_topics',
  'memory_extraction_progress','memory_backfill_progress','memory_extraction_jobs','session_context_references']);
let db;
try {
  db = new NativeDatabase(workerData.dbPath);
  configureStoreDatabase(db);
  parentPort.postMessage({type:'ready'});
} catch(error) { parentPort.postMessage({type:'fatal',error:serialize(error)}); }
parentPort.on('message', ({requestId,operation,input}) => {
  try {
    if(operation!=='coordinationCleanupPage' || !tables.has(input.table)) throw new Error('Unsupported cleanup operation');
    const column=input.table==='session_context_references'?'owner_session_id':'session_id';
    db.run('BEGIN IMMEDIATE');
    let result;
    try {
      const row=db.get('SELECT status,deleted_at FROM sessions WHERE id=?',[input.sessionId]);
      if(row && !row.deleted_at && row.status!=='deleted') throw new Error('Cannot reclaim an active Session');
      // Bound each write transaction; subsequent pages yield to interactive work.
      db.run(`DELETE FROM ${input.table} WHERE rowid IN (SELECT rowid FROM ${input.table} WHERE ${column}=? LIMIT 200)`,[input.sessionId]);
      result={deleted:db.getRowsModified()};
      db.run('COMMIT');
    } catch(error) { db.run('ROLLBACK'); throw error; }
    const payload=new TextEncoder().encode(JSON.stringify(result));
    parentPort.postMessage({type:'result',requestId,payload},[payload.buffer]);
  } catch(error) { parentPort.postMessage({type:'result',requestId,error:serialize(error)}); }
});
function serialize(error) { return {name:error.name,message:error.message,code:error.code,statusCode:error.statusCode}; }
