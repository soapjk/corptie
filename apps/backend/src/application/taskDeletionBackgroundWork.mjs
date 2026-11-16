import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worktreeProcesses } from '../utils/worktreeProcesses.mjs';
import { ProcessSupervisor } from '../runIsolation/processSupervisor.mjs';
import { worktreeProcessDetails } from '../utils/worktreeProcessDetails.mjs';
const exec = promisify(execFile);
const error = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

export function createTaskDeletionBackgroundWork({ store, probe = worktreeProcesses, supervisor = new ProcessSupervisor(), processOwner = workspaceProcessOwner, describe = worktreeProcessDetails, groups = async () => {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pgid='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return new Map(stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
} }) {
  function automations(taskId) {
    const sessions = store.listSessionsByTask(taskId).map(session => store.getLogicalSessionByLegacySessionId?.(session.id)?.logicalSessionId).filter(Boolean);
    return sessions.flatMap(logicalSessionId => store.listScheduledSessionTasks?.({ environment: store.environmentName, logicalSessionId }) ?? []);
  }
  async function identity(pid, runToken) {
    try { return await supervisor.identity(pid, { runToken }); }
    catch { return null; } // Keep details visible, but never authorize a signal.
  }
  async function inspect(taskId, path, { details = true } = {}) {
    const processes = await probe(path);
    if (!processes.length) return { processes: [], owners: [], canStop: false };
    const processGroups = await groups();
    const owners = [];
    for (const automation of automations(taskId)) {
      const spec = automation.processSpec;
      const expectedStart = spec?.expectedStartTime ?? automation.processState?.lastObservation?.startedAt;
      if (!spec?.pid || !expectedStart || !processes.some(p => p.pid === spec.pid)) continue;
      const observed = await identity(spec.pid, automation.taskId);
      if (!observed || Math.abs(Date.parse(observed.kernelStartTime) - Date.parse(expectedStart)) > 1000
        || !Number.isFinite(Date.parse(expectedStart))) continue;
      owners.push({ pid: observed.pid, pgid: processGroups.get(observed.pid) === observed.pid ? observed.pid : null,
        kernelStartTime: observed.kernelStartTime, executableHash: observed.executableRealpathHash, automationId: automation.taskId, purpose: automation.name ?? null });
    }
    // An explicit stop choice may include unregistered same-user processes.
    // Scope is their inspected working directory, never an unproven group.
    for (const candidate of processes) {
      if (owners.some(owner => owner.pid === candidate.pid || owner.pgid && processGroups.get(candidate.pid) === owner.pgid)) continue;
      if (!await processOwner(candidate.pid)) continue;
      const observed = await identity(candidate.pid, `task-deletion:${taskId}`);
      if (!observed) continue;
      if (!await processOwner(candidate.pid) || !(await probe(path)).some(p => p.pid === candidate.pid && p.path === candidate.path)) continue;
      owners.push({ pid: observed.pid, pgid: null, kernelStartTime: observed.kernelStartTime,
        executableHash: observed.executableRealpathHash, ownership: "user-worktree" });
    }
    const processDetails = details ? await describe(processes) : [];
    for (const detail of processDetails) {
      const owner = owners.find(owner => owner.pid === detail.pid || owner.pgid && processGroups.get(detail.pid) === owner.pgid);
      detail.canStop = Boolean(owner);
      detail.purpose = owner?.purpose ?? null;
    }
    return { processes, processDetails, owners, canStop: processes.every(p => owners.some(owner => owner.pid === p.pid || owner.pgid && processGroups.get(p.pid) === owner.pgid)) };
  }
  return {
    inspect,
    async stop(taskId, path) {
      const state = await inspect(taskId, path, { details: false });
      if (!state.processes.length) return;
      if (!state.canStop) throw error('TASK_BACKGROUND_IDENTITY_UNPROVEN', '后台进程归属尚未确认，请等待退出后继续清理。');
      for (const owner of state.owners) {
        if (owner.ownership === "user-worktree") {
          const present = (await probe(path)).some(p => p.pid === owner.pid);
          if (!present) continue;
          if (!await processOwner(owner.pid)) throw error('TASK_BACKGROUND_IDENTITY_UNPROVEN', '后台进程归属已变化，目录已保留，请重新检查。');
        }
        const result = await supervisor.terminate(owner);
        if (!['esrch', 'matchedExited'].includes(result.status)) throw error('TASK_BACKGROUND_STOP_INCOMPLETE', '后台工作尚未停止，目录已保留。');
      }
      if ((await probe(path)).length) throw error('TASK_BACKGROUND_STOP_INCOMPLETE', '仍有后台工作使用该目录，请等待退出。');
    },
    cancelWakeups(taskId) {
      for (const task of automations(taskId)) {
        if (!['active', 'paused', 'error'].includes(task.status)) continue;
        store.updateScheduledSessionTask(task.taskId, { status: 'cancelled', cancelledAt: new Date().toISOString(), nextRunAt: null, pendingScheduledFor: null }, task.resourceVersion);
      }
    }
  };
}

async function workspaceProcessOwner(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return false;
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'uid='], { timeout: 3000 });
    const [parent, uid] = stdout.trim().split(/\s+/).map(Number);
    return Number.isSafeInteger(parent) && uid === process.getuid?.();
  } catch (cause) { if (cause.code === 1 || cause.code === 'ESRCH') return false; throw cause; }
}
