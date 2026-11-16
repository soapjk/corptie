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
  const service = createTaskDeletionBackgroundWork({ store, processOwner: async () => false, probe: async () => processes, groups: async () => new Map([[100,100],[101,100],[200,200]]),
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

function orphanFixture({ orphan = true, moved = false, result = 'matchedExited' } = {}) {
  let processes = [{ pid: 200, path: '/work/backend' }];
  let probes = 0;
  const signals = [];
  const service = createTaskDeletionBackgroundWork({
    store: { listSessionsByTask: () => [] },
    groups: async () => new Map([[200, 999]]),
    processOwner: async () => orphan,
    probe: async () => { probes++; return moved && probes > 1 ? [] : processes; },
    supervisor: {
      identity: async pid => ({ pid, kernelStartTime: 'start', executableRealpathHash: 'hash' }),
      terminate: async owner => { signals.push(owner); if (result === 'matchedExited') processes = []; return { status: result }; }
    }
  });
  return { service, signals };
}
test('legacy orphan in dedicated worktree is stoppable without signalling its foreign process group', async () => {
  const f = orphanFixture();
  assert.equal((await f.service.inspect('task', '/work')).canStop, true);
  await f.service.stop('task', '/work');
  assert.equal(f.signals.length, 1);
  assert.equal(f.signals[0].pgid, null);
  assert.equal(f.signals[0].kernelStartTime, 'start');
});
for (const input of [{ orphan: false }, { moved: true }]) test('unowned or moved legacy process is not stoppable ' + JSON.stringify(input), async () => {
  const f = orphanFixture(input);
  assert.equal((await f.service.inspect('task', '/work')).canStop, false);
  assert.equal(f.signals.length, 0);
});
test('PID reuse during orphan stop fails closed', async () => {
  const f = orphanFixture({ result: 'pidReused' });
  await assert.rejects(f.service.stop('task', '/work'), { code: 'TASK_BACKGROUND_STOP_INCOMPLETE' });
});

test('real detached legacy backend in an isolated directory can stop and release its workspace', { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const { mkdtemp, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'corptie-delete-orphan-')));
  let pid;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['-e',
      'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","process.title=\\"node\\";setInterval(()=>{},1000)"],{cwd:process.argv[1],detached:true,stdio:"ignore"});console.log(c.pid);c.unref();',
      root]);
    pid = Number(stdout.trim());
    assert.ok(pid > 1);
    const service = createTaskDeletionBackgroundWork({ store: { listSessionsByTask: () => [] } });
    const started = performance.now();
    const state = await service.inspect('isolated-task', root);
    assert.equal(state.canStop, true);
    assert.equal(state.owners[0].pgid, null);
    assert.ok(performance.now() - started < 5000, 'inspection remains bounded');
    await service.stop('isolated-task', root);
    assert.equal((await service.inspect('isolated-task', root)).processes.length, 0);
    pid = null;
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit stop can include an unregistered live same-user process, not just orphans', { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const { mkdtemp, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'corptie-delete-live-')));
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const service = createTaskDeletionBackgroundWork({ store: { listSessionsByTask: () => [] } });
    const state = await service.inspect('isolated-task', root);
    assert.equal(state.canStop, true);
    assert.equal(state.processDetails[0].orphaned, false);
    assert.equal(state.processDetails[0].parentPid, process.pid);
    assert.equal(state.processDetails[0].purpose, null);
    await service.stop('isolated-task', root);
    assert.equal((await service.inspect('isolated-task', root)).processes.length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('unobservable identity keeps process details visible without granting stop permission', async () => {
  const service = createTaskDeletionBackgroundWork({
    store: { listSessionsByTask: () => [] },
    probe: async () => [{ pid: 123, path: '/work' }], groups: async () => new Map(),
    processOwner: async () => true,
    describe: async () => [{ pid: 123, processName: 'node', workingDirectory: '/work' }],
    supervisor: { identity: async () => { throw new Error('permission denied'); } }
  });
  const result = await service.inspect('task', '/work');
  assert.equal(result.canStop, false);
  assert.equal(result.processDetails[0].processName, 'node');
  assert.equal(result.processDetails[0].canStop, false);
});

test('current backend and its parent remain protected even inside an inspected directory', async () => {
  const service = createTaskDeletionBackgroundWork({
    store: { listSessionsByTask: () => [] },
    probe: async () => [{ pid: process.pid, path: '/work' }, { pid: process.ppid, path: '/work' }],
    groups: async () => new Map(), describe: async () => [],
    supervisor: { identity: async () => { throw new Error('must not inspect protected process'); } }
  });
  assert.equal((await service.inspect('task', '/work')).canStop, false);
  await assert.rejects(service.stop('task', '/work'), { code: 'TASK_BACKGROUND_IDENTITY_UNPROVEN' });
});
