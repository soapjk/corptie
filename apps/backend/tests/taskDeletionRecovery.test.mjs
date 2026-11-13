import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink, rm, realpath, rename, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deletionDirectoryIdentity, inspectTaskDeletionRecovery, resumeTaskDeletionCleanup } from '../src/runtime/taskDeletionRecovery.mjs';
const exec = promisify(execFile);
async function fixture(t, checkpoint = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delete-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main'), path = join(root, 'child'); await mkdir(main);
  const git = async (cwd, args) => (await exec('git', ['-C', cwd, ...args])).stdout;
  await git(main, ['init', '-b', 'main']); await git(main, ['config', 'user.name', 'Test']); await git(main, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(main, 'file'), 'fixture'); await git(main, ['add', '.']); await git(main, ['commit', '-m', 'initial']);
  await git(main, ['worktree', 'add', '-b', 'task/child', path]);
  const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
  const target = { taskId: 'task:child', repositoryId: 'repo', worktreeId: 'tree', path, branchName: 'task/child', headOid: head, bindingRevision: 1 };
  const operation = { operationId: 'deletion:one', taskId: target.taskId, state: 'failed', startedAt: new Date(Date.now() + 1000).toISOString(), input: { target }, result: null };
  if (checkpoint) operation.result = { cleanup: { removalStarted: true, directoryIdentity: await deletionDirectoryIdentity(path), sourceHead: head } };
  let binding = { worktree_id: 'tree', binding_revision: 1 };
  const updates = [];
  const manager = { store: {
    getTask: () => ({ id: target.taskId }), getTaskDeliveryBinding: () => binding,
    getGitWorktree: () => ({ repositoryId: 'repo', path, isMain: false }), listGitWorktrees: () => [{ isMain: true, path: main }],
    listLogicalSessionsByWorkspaceId: () => [],
    updateTaskDeletionOperation: (_id, patch) => { updates.push(patch); Object.assign(operation, patch); },
    upsertGitWorkspaceSnapshot: () => {}
  }, gitOutput: git, runGit: git, gitOptionalOutput: async (cwd, args) => { try { return await git(cwd, args); } catch (e) { if ([1,128].includes(e.code)) return null; throw e; } }, operationSnapshot: async () => ({}) };
  async function partiallyRemove() { await unlink(join(path, '.git')); await git(main, ['worktree', 'prune', '--expire=now']); }
  return { main, path, root, operation, manager, git, updates, partiallyRemove, rebind: () => { binding = { worktree_id: 'other', binding_revision: 2 }; } };
}

test('partial Git removal preserves inode and resumes through native deletion with a branch CAS', async t => {
  const f = await fixture(t); await f.partiallyRemove();
  const recovery = await inspectTaskDeletionRecovery(f.manager, f.operation);
  assert.equal(recovery.pendingCleanup.recoveryRequired, true);
  const result = await resumeTaskDeletionCleanup(f.manager, f.operation, recovery);
  assert.equal(result.worktreeRemoved, true);
  await assert.rejects(access(f.path));
  assert.equal(await f.manager.gitOptionalOutput(f.main, ['rev-parse', '--verify', 'refs/heads/task/child']), null);
  assert.equal(f.updates[0].stage, 'worktree_recovery');
  assert.equal(f.updates[1].stage, 'branch_cleanup');
  const replay = await inspectTaskDeletionRecovery(f.manager, f.operation);
  assert.equal((await resumeTaskDeletionCleanup(f.manager, f.operation, replay)).removed, true);
});

test('legacy failed receipt recovers only the old directory and unchanged branch', async t => {
  const f = await fixture(t, false); await f.partiallyRemove();
  assert.ok((await inspectTaskDeletionRecovery(f.manager, f.operation)).pendingCleanup.directoryIdentity);
  f.operation.startedAt = new Date(0).toISOString();
  await assert.rejects(inspectTaskDeletionRecovery(f.manager, f.operation), { code: 'TASK_DELETE_IDENTITY_UNPROVEN' });
});

test('recreated directory cannot reuse the prior cleanup identity', async t => {
  const f = await fixture(t); await f.partiallyRemove();
  await rename(f.path, f.path + '-old'); await mkdir(f.path); await writeFile(join(f.path, 'keep'), 'new owner');
  await assert.rejects(inspectTaskDeletionRecovery(f.manager, f.operation), { code: 'TASK_DELETE_SCOPE_INVALID' });
  await access(join(f.path, 'keep'));
});

test('symlink and changed binding fail closed', async t => {
  const f = await fixture(t); await f.partiallyRemove(); await rename(f.path, f.path + '-old'); await symlink(f.main, f.path);
  await assert.rejects(inspectTaskDeletionRecovery(f.manager, f.operation), { code: 'TASK_DELETE_SCOPE_INVALID' });
  await unlink(f.path); await rename(f.path + '-old', f.path); f.rebind();
  await assert.rejects(inspectTaskDeletionRecovery(f.manager, f.operation), { code: 'TASK_DELETE_SCOPE_INVALID' });
});

test('moved branch and a branch checked out elsewhere block residual cleanup', async t => {
  const f = await fixture(t); await f.partiallyRemove();
  await writeFile(join(f.main, 'second'), 'new'); await f.git(f.main, ['add', '.']); await f.git(f.main, ['commit', '-m', 'new']);
  await f.git(f.main, ['branch', '-f', 'task/child', 'main']);
  await assert.rejects(inspectTaskDeletionRecovery(f.manager, f.operation), { code: 'TASK_DELETE_SCOPE_INVALID' });
  await f.git(f.main, ['branch', '-f', 'task/child', f.operation.input.target.headOid]);
  await f.git(f.main, ['worktree', 'add', join(f.root, 'other'), 'task/child']);
  await assert.rejects(inspectTaskDeletionRecovery(f.manager, f.operation), { code: 'WORKTREE_IN_USE' });
});

test('directory absent with stale Git registration resumes cleanup', async t => {
  const f = await fixture(t); await rm(f.path, { recursive: true });
  const recovery = await inspectTaskDeletionRecovery(f.manager, f.operation);
  assert.equal(recovery.registrationPresent, true);
  assert.equal((await resumeTaskDeletionCleanup(f.manager, f.operation, recovery)).removed, true);
});

test('identity is rechecked between preflight and removal', async t => {
  const f = await fixture(t); await f.partiallyRemove();
  const recovery = await inspectTaskDeletionRecovery(f.manager, f.operation);
  await rename(f.path, f.path + '-old'); await mkdir(f.path);
  await assert.rejects(resumeTaskDeletionCleanup(f.manager, f.operation, recovery), { code: 'TASK_DELETE_SCOPE_INVALID' });
});
