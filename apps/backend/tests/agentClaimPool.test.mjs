import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CorptieStore } from '../src/store/corptieStore.mjs';
import { CollaborationCore } from '../src/collaboration/collaborationCore.mjs';
import { AgentClaimPool } from '../src/store/agentClaimPool.mjs';
import { executeAgentClaim } from '../src/store/agentClaimOperation.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'corptie-claim-worker-'));
  const dbPath = join(directory, 'test.sqlite');
  const store = new CorptieStore({ dbPath, configPath: join(directory, 'config.json'), dataRoot: directory });
  await store.initialize();
  const core = new CollaborationCore(store);
  core.registerAgent({ agentId: 'agent', name: 'Agent' });
  for (const sessionId of ['codex:a', 'claude:b']) core.bindSession({ agentId: 'agent', sessionId });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const add = (taskId, sessionId = 'codex:a') => store.enqueueAgentTask({ taskId, sessionId, agentId: 'agent',
    kind: 'user', priority: 100, text: taskId, source: {}, createdAt: '2026-01-01T00:00:00Z' });
  return { store, dbPath, add };
}

test('writer claims atomically across independent writers, isolates Sessions and rejects stale snapshots', async t => {
  const { store, dbPath, add } = await fixture(t);
  const writers = [new AgentClaimPool({ dbPath }), new AgentClaimPool({ dbPath })];
  t.after(async () => { await Promise.all(writers.map(w => w.close())); });
  const first = add('first'), second = add('second'), other = add('other', 'claude:b');
  const claims = await Promise.all([writers[0].claim(first), writers[1].claim(second), writers[0].claim(other)]);
  assert.equal(claims.slice(0, 2).filter(Boolean).length, 1);
  assert.equal(claims[2].taskId, 'other');
  const stale = add('stale');
  store.updateAgentTask(stale.taskId, { text: 'changed' });
  for (const item of claims.filter(Boolean)) store.updateAgentTask(item.taskId, { status: 'completed' });
  assert.equal(await writers[0].claim(stale), null);
  store.db.run("INSERT INTO logical_sessions(logical_session_id,legacy_session_id,transition_state,created_at,updated_at) VALUES('logical','codex:a','committingRoute','2026-01-01','2026-01-01')");
  assert.equal(await writers[1].claim(store.getAgentTask('stale')), null);
});

test('receipt and claim roll back together; replay does not claim again after settlement', async t => {
  const { store, add } = await fixture(t);
  const item = add('atomic');
  const input = { ...item, requestId: 'receipt-atomic' };
  store.db.run("CREATE TRIGGER reject_claim_receipt BEFORE INSERT ON agent_operation_claims BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => executeAgentClaim(store.db, input));
  assert.equal(store.getAgentTask(item.taskId).status, 'queued');
  store.db.run('DROP TRIGGER reject_claim_receipt');
  const claimed = executeAgentClaim(store.db, input);
  assert.equal(executeAgentClaim(store.db, input).startedAt, claimed.startedAt);
  store.updateAgentTask(item.taskId, { status: 'completed' });
  assert.equal(executeAgentClaim(store.db, input), null);
});

for (const mode of ['lost-reply', 'before-commit', 'late-reply']) {
  test(`outcome reconciliation without replay: ${mode}`, async t => {
    const { store, dbPath, add } = await fixture(t);
    const pool = new AgentClaimPool({ dbPath, timeoutMs: 1000, workerURL: new URL('./fixtures/agentClaimFaultWorker.mjs', import.meta.url) });
    t.after(() => pool.close());
    const result = await pool.claim(add(mode));
    assert.equal(result?.status ?? null, mode === 'before-commit' ? null : 'running');
    assert.equal(store.getAgentTask(mode).status, mode === 'before-commit' ? 'queued' : 'running');
    assert.equal(store.db.get('SELECT count(*) AS count FROM agent_operation_claims').count, mode === 'before-commit' ? 0 : 1);
  });
}

test('unready worker and bounded queues fail promptly and close cleanly', async () => {
  const pool = new AgentClaimPool({ dbPath: 'unused', timeoutMs: 100, maxQueue: 1,
    workerURL: new URL('data:text/javascript,import {parentPort} from "node:worker_threads";parentPort.on("message",()=>{});') });
  const pending = assert.rejects(pool.request('inspect', {}), /CLAIM_WORKER_UNAVAILABLE|CLAIM_QUEUE_TIMEOUT/);
  await assert.rejects(pool.request('inspect', {}), { code: 'CLAIM_QUEUE_FULL' });
  await pending;
  await pool.close();
  await assert.rejects(pool.request('claim', {}), { code: 'CLAIM_POOL_CLOSED' });
});

test('store refuses claims during migration and after close', async t => {
  const { store, add } = await fixture(t);
  const item = add('guard');
  assert.throws(() => store.runInTransaction(() => store.claimAgentTaskAsync(item)), /Promise/);
  assert.equal(store.agentClaimPool, undefined);
  store.migrationInProgress = true;
  await assert.rejects(store.claimAgentTaskAsync(item), { code: 'STORE_CLAIM_UNAVAILABLE' });
  store.migrationInProgress = false;
  assert.equal((await store.claimAgentTaskAsync(item)).status, 'running');
  await store.close();
  await assert.rejects(store.claimAgentTaskAsync(item), { code: 'STORE_CLAIM_UNAVAILABLE' });
});
