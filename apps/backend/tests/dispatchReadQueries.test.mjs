import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDatabase } from '../src/store/nativeDatabase.mjs';
import { readMailboxDispatchPage, mailboxCandidatePageSql } from '../src/store/dispatchReadQueries.mjs';

test('queue discovery skips history using the live index and advances past ineligible candidates', () => {
  const db = new NativeDatabase(':memory:');
  try {
    db.run(`CREATE TABLE session_mailbox_messages(sequence INTEGER PRIMARY KEY,operation_id TEXT,recipient_session_id TEXT,
      disposition TEXT,manual_requested INTEGER,intent TEXT);
      CREATE TABLE agent_operations(task_id TEXT PRIMARY KEY,status TEXT);
      CREATE INDEX idx_session_mailbox_dispatch_candidates ON session_mailbox_messages(sequence,operation_id,recipient_session_id)
        WHERE disposition='pending' AND operation_id IS NOT NULL
        AND (manual_requested=1 OR intent IN ('action_required','response_required','notification'));
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
        INSERT INTO session_mailbox_messages SELECT i,'old:'||i,'session:a','adopted',0,'notification' FROM n;
      INSERT INTO agent_operations VALUES('blocked','completed'),('ready','queued');
      INSERT INTO session_mailbox_messages VALUES(10001,'blocked','session:a','pending',0,'notification'),
        (10002,'ready','session:b','pending',0,'notification');`);
    const plan = db.all('EXPLAIN QUERY PLAN '+mailboxCandidatePageSql, [0,1]);
    assert.ok(plan.some(r => r.detail.includes('idx_session_mailbox_dispatch_candidates')));
    const first = readMailboxDispatchPage(db,{limit:1});
    assert.equal(first.rows.length,0);
    assert.equal(first.nextCursor,10001);
    const second = readMailboxDispatchPage(db,{after:first.nextCursor,limit:1});
    assert.equal(second.rows[0].operation_id,'ready');
    assert.equal(readMailboxDispatchPage(db,{after:second.nextCursor,limit:1}).nextCursor,0);
  } finally { db.close(); }
});
