import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeDatabase} from '../src/store/nativeDatabase.mjs';
import {CoordinationCleanupPool} from '../src/store/coordinationCleanupPool.mjs';

test('cleanup batches only retired Session rows and survives idempotent replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'corptie-cleanup-'));
  const dbPath=join(directory,'db.sqlite');
  const db=new NativeDatabase(dbPath);
  let pool;
  try {
    db.run("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT,deleted_at TEXT); INSERT INTO sessions VALUES('old','deleted','now'),('live','running',NULL);");
    for(const table of ['session_items','session_events','session_logs','provider_event_inbox','event_outbox',
      'message_deliveries','session_turns','session_execution_plan_state','session_memory_topics','memory_extraction_progress','memory_backfill_progress','memory_extraction_jobs','session_context_references']) {
      const column=table==='session_context_references'?'owner_session_id':'session_id';
      db.run(`CREATE TABLE ${table}(${column} TEXT); CREATE INDEX idx_${table} ON ${table}(${column});
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<405)
        INSERT INTO ${table} SELECT 'old' FROM n; INSERT INTO ${table} VALUES('live');`);
    }
    pool=new CoordinationCleanupPool({dbPath});
    await assert.rejects(pool.reclaimSessionRows('live'),/active Session/);
    await pool.reclaimSessionRows('old');
    await pool.reclaimSessionRows('old');
    assert.deepEqual(db.all('SELECT * FROM session_events'),[{session_id:'live'}]);
  } finally {await pool?.close();db.close();await rm(directory,{recursive:true,force:true});}
});
