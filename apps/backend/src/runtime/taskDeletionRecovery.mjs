import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { loadNativeSafeDeletion } from '../runIsolation/nativeSafeDeletion.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409, stage: 'worktree_recovery' }); };
const identityKeys = ['rootDeviceId', 'rootInode', 'targetDeviceId', 'targetInode'];
export async function deletionDirectoryIdentity(path) {
  if (!path || resolve(path) !== path || dirname(path) === path) fail('TASK_DELETE_SCOPE_INVALID', '删除路径不是明确的专属目录。');
  let target;
  try { target = await lstat(path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!target.isDirectory() || target.isSymbolicLink() || await realpath(path) !== path) fail('TASK_DELETE_SCOPE_INVALID', '删除目标被替换或包含链接，请重新核对。');
  const root = await lstat(dirname(path), { bigint: true });
  return { rootDeviceId: String(root.dev), rootInode: String(root.ino), targetDeviceId: String(target.dev), targetInode: String(target.ino), birthtimeMs: Number(target.birthtimeMs) };
}

// Reconcile only a server-owned deletion intent. Missing Git metadata alone is
// never evidence that an arbitrary directory belongs to this operation.
export async function inspectTaskDeletionRecovery(manager, operation) {
  const target = operation?.input?.target;
  if (!target?.path || !target.worktreeId || !['running', 'failed', 'queued'].includes(operation.state)) return null;
  const task = manager.store.getTask(target.taskId);
  const binding = manager.store.getTaskDeliveryBinding?.(target.taskId);
  const source = manager.store.getGitWorktree(target.worktreeId);
  if (!task || operation.taskId !== target.taskId || source?.isMain
    || (source && (source.path !== target.path || source.repositoryId !== target.repositoryId))
    || (binding && (binding.worktree_id !== target.worktreeId || binding.binding_revision !== target.bindingRevision))) {
    fail('TASK_DELETE_SCOPE_INVALID', '原删除目标的绑定已经改变，不能继续清理。');
  }
  const main = manager.store.listGitWorktrees(target.repositoryId).find(tree => tree.isMain);
  if (!main || main.path === target.path) fail('TASK_DELETE_SCOPE_INVALID', '无法确认主工作区与删除目标的边界。');
  for (const route of manager.store.listLogicalSessionsByWorkspaceId(target.worktreeId)) {
    if ((route.taskId ?? manager.store.getSession(route.legacySessionId)?.taskId) !== target.taskId) fail('SHARED_WITH_ACTIVE_TASK', '目标已被其他任务使用。');
  }
  const identity = await deletionDirectoryIdentity(target.path);
  const checkpoint = operation.result?.cleanup ?? operation.input?.resumeCleanup ?? {};
  if (identity && checkpoint.directoryIdentity && !identityKeys.every(key => identity[key] === checkpoint.directoryIdentity[key])) {
    fail('TASK_DELETE_SCOPE_INVALID', '原目录已被替换，禁止清理新目录。');
  }
  const inventory = await manager.gitOutput(main.path, ['worktree', 'list', '--porcelain', '-z']);
  const records = inventory.split('\0\0').filter(Boolean).map(record => record.split('\0'));
  const registered = records.find(fields => fields.includes(`worktree ${target.path}`));
  const hasGit = await lstat(`${target.path}/.git`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (identity && hasGit && registered && !checkpoint.worktreeRemoved) {
    if (checkpoint.removalStarted && (await manager.gitOutput(target.path, ['rev-parse', '--verify', 'HEAD'])).trim() !== (checkpoint.sourceHead ?? target.headOid)) {
      fail('TASK_DELETE_SCOPE_INVALID', '清理开始后工作区提交已改变，不能覆盖原删除目标。');
    }
    return null;
  }
  if (hasGit) fail('TASK_DELETE_SCOPE_INVALID', '目标目录出现新的 Git 元数据，不能按残留清理。');
  const branch = checkpoint.sourceBranch ?? target.branchName;
  const head = checkpoint.sourceHead ?? target.headOid;
  if (!branch || !head) fail('TASK_DELETE_IDENTITY_UNPROVEN', '缺少原分支身份，需核对后再恢复删除。');
  if (records.some(fields => !fields.includes(`worktree ${target.path}`) && fields.includes(`branch refs/heads/${branch}`))) fail('WORKTREE_IN_USE', '原分支已被其他工作区使用。');
  const currentHead = await manager.gitOptionalOutput(main.path, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  if (currentHead?.trim() && currentHead.trim() !== head) fail('TASK_DELETE_SCOPE_INVALID', '原分支已发生变化，不能继续删除。');
  // Legacy receipts have no inode checkpoint. Require the original DB binding,
  // unchanged branch, and a directory demonstrably older than the deletion.
  if (identity && !checkpoint.directoryIdentity && (!source || !currentHead?.trim()
    || !(identity.birthtimeMs > 0 && identity.birthtimeMs < Date.parse(operation.startedAt ?? operation.createdAt)))) {
    fail('TASK_DELETE_IDENTITY_UNPROVEN', '旧删除记录无法证明残留目录身份，需核对后再清理。');
  }
  return { status: 'available', repositoryId: target.repositoryId,
    pendingCleanup: { ...checkpoint, recoveryRequired: true, directoryIdentity: identity ?? checkpoint.directoryIdentity ?? null,
      sourceWorktreeId: target.worktreeId, sourcePath: target.path, sourceBranch: branch, sourceHead: head },
    recoveryTarget: target,
    worktree: { worktreeId: target.worktreeId, path: target.path, branchName: branch, headOid: head,
      dirty: false, mergedIntoMain: true, sessions: manager.store.listLogicalSessionsByWorkspaceId(target.worktreeId).map(route => ({ logicalSessionId: route.logicalSessionId, sessionId: route.legacySessionId })) },
    registrationPresent: Boolean(registered), mainPath: main.path };
}

export async function resumeTaskDeletionCleanup(manager, operation, recovery) {
  const target = operation.input.target;
  const cleanup = recovery.pendingCleanup;
  manager.store.updateTaskDeletionOperation(operation.operationId, { stage: 'worktree_recovery', result: { ...operation.result, cleanup } });
  const current = await deletionDirectoryIdentity(target.path);
  if (current) {
    if (!cleanup.directoryIdentity || !identityKeys.every(key => current[key] === cleanup.directoryIdentity[key])) fail('TASK_DELETE_SCOPE_INVALID', '清理前目录身份发生变化。');
    // Existing native openat/O_NOFOLLOW implementation rejects link/mount races.
    const safety = manager.taskDeletionNativeSafety ?? loadNativeSafeDeletion();
    safety.delete(dirname(target.path), basename(target.path), cleanup.directoryIdentity);
  }
  if (recovery.registrationPresent) {
    await manager.runGit(recovery.mainPath, ['worktree', 'remove', '--force', '--force', target.path]);
  }
  const removed = { ...cleanup, worktreeRemoved: true };
  manager.store.updateTaskDeletionOperation(operation.operationId, { stage: 'branch_cleanup', result: { ...operation.result, cleanup: removed } });
  if (await manager.gitOptionalOutput(recovery.mainPath, ['rev-parse', '--verify', `refs/heads/${cleanup.sourceBranch}`])) {
    await manager.runGit(recovery.mainPath, ['update-ref', '-d', `refs/heads/${cleanup.sourceBranch}`, cleanup.sourceHead]);
  }
  manager.store.upsertGitWorkspaceSnapshot(await manager.operationSnapshot(recovery.mainPath, { repositoryId: target.repositoryId }));
  return { ...removed, removed: true, branchDeleted: true };
}
