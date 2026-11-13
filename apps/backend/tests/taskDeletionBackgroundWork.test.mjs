import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskDeletionBackgroundWork } from '../src/application/taskDeletionBackgroundWork.mjs';

function fixture({ known = true, reused = false, foreign = false } = {}) {
  let processes = [{ pid: 100, path: '/work' }, { pid: 101, path: '/work' }];
  if (foreign) processes.push({ pid: 200, path: '/work' });
  const calls = [];
  const start = 'Fri Nov 13 14:00:00 2026';
  const store = { listSessionsByTask: () => [{ id: 'session' }], getLogicalSessionByLegacySessionId: () => ({ logicalSessionId: 'logical' }),
    listScheduledSessionTasks: () => [{ taskId: 'automation', status: 'active', resourceVersion: 1,
      processSpec: { pid: 100, expectedStartTime: known ? new Date(start).toISOString() : null } }],
    updateScheduledSessionTask: (...args) => calls.push(args) };
  const service = createTaskDeletionBackgroundWork({ store, probe: async () => processes, groups: async () => new Map([[100,100],[101,100],[200,200]]),
    supervisor: { identity: async () => ({ pid: 100, kernelStartTime: reused ? 'Fri Nov 13 15:00:00 2026' : start, executableRealpathHash: 'hash' }),
      terminate: async identity => { calls.push(identity); processes = []; return { status: 'matchedExited' }; } } });
  return { service, calls };
}
test('owned process group stops and wakeups cancel only for the bound Session', async () => {
  const f = fixture(); assert.equal((await f.service.inspect('task','/work')).canStop, true);
  await f.service.stop('task','/work'); assert.equal(f.calls[0].pgid, 100);
  f.service.cancelWakeups('task'); assert.equal(f.calls[1][1].status, 'cancelled');
});
for (const input of [{ known: false }, { reused: true }, { foreign: true }]) test(`unproven process identity never signals: ${JSON.stringify(input)}`, async () => {
  const f = fixture(input); assert.equal((await f.service.inspect('task','/work')).canStop, false);
  await assert.rejects(f.service.stop('task','/work'), { code: 'TASK_BACKGROUND_IDENTITY_UNPROVEN' }); assert.equal(f.calls.length, 0);
});

test('background inspection errors remain explicit instead of permitting deletion', async () => {
  const service = createTaskDeletionBackgroundWork({ store: {}, probe: async () => { throw Object.assign(new Error('probe failed'), { code: 'TASK_BACKGROUND_INSPECTION_FAILED' }); } });
  await assert.rejects(service.inspect('task','/work'), { code: 'TASK_BACKGROUND_INSPECTION_FAILED' });
});
