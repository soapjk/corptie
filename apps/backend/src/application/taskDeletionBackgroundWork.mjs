import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worktreeProcesses } from '../utils/worktreeProcesses.mjs';
import { ProcessSupervisor } from '../runIsolation/processSupervisor.mjs';
const exec = promisify(execFile);
const error = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

export function createTaskDeletionBackgroundWork({ store, probe = worktreeProcesses, supervisor = new ProcessSupervisor(), groups = async () => {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pgid='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return new Map(stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
} }) {
  function automations(taskId) {
    const sessions = store.listSessionsByTask(taskId).map(session => store.getLogicalSessionByLegacySessionId?.(session.id)?.logicalSessionId).filter(Boolean);
    return sessions.flatMap(logicalSessionId => store.listScheduledSessionTasks?.({ environment: store.environmentName, logicalSessionId }) ?? []);
  }
  async function inspect(taskId, path) {
    const processes = await probe(path);
    if (!processes.length) return { processes: [], owners: [], canStop: false };
    const processGroups = await groups();
    const owners = [];
    for (const automation of automations(taskId)) {
      const spec = automation.processSpec;
      const expectedStart = spec?.expectedStartTime ?? automation.processState?.lastObservation?.startedAt;
      if (!spec?.pid || !expectedStart || !processes.some(p => p.pid === spec.pid)) continue;
      const observed = await supervisor.identity(spec.pid, { runToken: automation.taskId });
      if (!observed || Math.abs(Date.parse(observed.kernelStartTime) - Date.parse(expectedStart)) > 1000
        || !Number.isFinite(Date.parse(expectedStart))) continue;
      owners.push({ pid: observed.pid, pgid: processGroups.get(observed.pid) === observed.pid ? observed.pid : null,
        kernelStartTime: observed.kernelStartTime, executableHash: observed.executableRealpathHash, automationId: automation.taskId });
    }
    return { processes, owners, canStop: processes.every(p => owners.some(owner => owner.pid === p.pid || owner.pgid && processGroups.get(p.pid) === owner.pgid)) };
  }
  return {
    inspect,
    async stop(taskId, path) {
      const state = await inspect(taskId, path);
      if (!state.processes.length) return;
      if (!state.canStop) throw error('TASK_BACKGROUND_IDENTITY_UNPROVEN', '后台进程归属尚未确认，请等待退出后继续清理。');
      for (const owner of state.owners) {
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
