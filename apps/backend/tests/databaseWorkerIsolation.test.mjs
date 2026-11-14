import test from 'node:test';
import assert from 'node:assert/strict';
import {TimelineReadPool} from '../src/store/timelineReadPool.mjs';

test('a blocked database reader leaves the event loop responsive and is terminated at its deadline',async()=>{
  const pool=new TimelineReadPool({size:1,dbPath:':memory:',requestTimeoutMs:100,
    workerURL:new URL('./fixtures/blockedDatabaseReadWorker.mjs',import.meta.url)});
  let beats=0;
  const timer=setInterval(()=>beats++,10);
  try {
    await assert.rejects(pool.readMailboxDispatchPage({}),{code:'BACKGROUND_READ_TIMEOUT'});
    assert.ok(beats>=3,'main thread must continue processing timers');
    await assert.rejects(pool.readMailboxDispatchPage({after:1}),{code:'BACKGROUND_READ_TIMEOUT'});
  } finally {clearInterval(timer);await pool.close();}
});
