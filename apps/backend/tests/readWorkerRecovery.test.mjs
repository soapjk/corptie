import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TimelineReadPool } from '../src/store/timelineReadPool.mjs';
import { NativeDatabase } from '../src/store/nativeDatabase.mjs';
const inline = code => new URL(`data:text/javascript,${encodeURIComponent(code)}`);

test('fatal initialization rejects both waiting and future requests and permits close', async () => {
  const pool = new TimelineReadPool({ dbPath: 'unused', size: 1, workerURL: inline(`
    import {parentPort} from 'node:worker_threads';
    parentPort.postMessage({type:'fatal',error:{message:'injected',code:'INIT_FAILED'}});`) });
  await assert.rejects(pool.readMailboxDispatchPage({}), { code: 'INIT_FAILED' });
  // A request during termination is bounded, too.
  await assert.rejects(pool.readMailboxDispatchPage({ afterFailure: true }));
  await pool.close();
});

test('ready-then-crash cannot reset the restart budget indefinitely', async () => {
  const pool = new TimelineReadPool({ dbPath: 'unused', size: 1, queueTimeoutMs: 2000, workerURL: inline(`
    import {parentPort} from 'node:worker_threads';
    parentPort.postMessage({type:'ready'});
    parentPort.on('message',()=>process.exit(1));`) });
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(pool.readMailboxDispatchPage({ i }));
    await delay(50);
    await assert.rejects(pool.readMailboxDispatchPage({}), { code: 'TIMELINE_READ_WORKER_UNAVAILABLE' });
  } finally { await pool.close(); }
});

test('queue deadline covers a worker which never becomes ready', async () => {
  const pool = new TimelineReadPool({ dbPath: 'unused', size: 1, queueTimeoutMs: 50,
    workerURL: inline(`import {parentPort} from 'node:worker_threads';parentPort.on('message',()=>{});`) });
  try { await assert.rejects(pool.readMailboxDispatchPage({}), { code: 'TIMELINE_READ_QUEUE_TIMEOUT' }); }
  finally { await pool.close(); }
});

test('30-second SQLite background read leaves HTTP and independent interactive capacity responsive', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'corptie-read-isolation-'));
  const dbPath = join(directory, 'test.sqlite');
  const db = new NativeDatabase(dbPath); db.run('CREATE TABLE fixture(id INTEGER)'); db.close();
  const options = { dbPath, size: 1, requestTimeoutMs: 35000, workerURL: new URL('./fixtures/slowReadWorker.mjs', import.meta.url) };
  const background = new TimelineReadPool(options), interactive = new TimelineReadPool(options);
  const server = createServer((_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const slow = background.readMailboxDispatchPage({ delay: 30000 });
    await delay(250);
    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      assert.equal(await response.text(), 'ok');
      assert.equal((await interactive.readTimelineWindow({ i })).complete, 1);
      latencies.push(performance.now() - start);
      await delay(100);
    }
    assert.ok(Math.max(...latencies) < 1000, JSON.stringify(latencies));
    assert.equal((await slow).complete, 1);
    t.diagnostic(`injectedSlowSQL=30000ms interactiveAndHTTPMax=${Math.max(...latencies).toFixed(2)}ms`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.all([background.close(), interactive.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('execution timeout retires the active reader and subsequent reads recover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corptie-read-timeout-'));
  const dbPath = join(directory, 'test.sqlite');
  const db = new NativeDatabase(dbPath); db.run('CREATE TABLE fixture(id INTEGER)'); db.close();
  const pool = new TimelineReadPool({ dbPath, size: 1, requestTimeoutMs: 100, queueTimeoutMs: 3000,
    workerURL: new URL('./fixtures/slowReadWorker.mjs', import.meta.url) });
  try {
    await pool.readMailboxDispatchPage({});
    await assert.rejects(pool.readMailboxDispatchPage({ delay: 300 }), { code: 'BACKGROUND_READ_TIMEOUT' });
    assert.equal((await pool.readMailboxDispatchPage({ recovered: true })).complete, 1);
  } finally { await pool.close(); await rm(directory, { recursive: true, force: true }); }
});
