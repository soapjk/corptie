import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, isAbsolute } from 'node:path';
const exec = promisify(execFile);

// Only executable identity is collected: arguments/environment can contain secrets.
export async function worktreeProcessDetails(processes, { execute = exec } = {}) {
  const result = new Array(processes.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, processes.length) }, async () => {
    for (let index; (index = next++) < processes.length;) {
      const candidate = processes[index];
      const detail = { pid: candidate.pid, workingDirectory: candidate.path };
      try {
        const { stdout } = await execute('/bin/ps', ['-p', String(candidate.pid), '-o', 'ppid=', '-o', 'state=', '-o', 'etime=', '-o', 'comm='],
          { timeout: 2000, maxBuffer: 65536 });
        const match = stdout.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!match) throw new Error('Process observation unavailable');
        detail.parentPid = Number(match[1]);
        detail.state = match[2].startsWith('Z') ? 'zombie' : match[2].startsWith('T') ? 'stopped'
          : match[2].startsWith('R') ? 'running' : ['S', 'I', 'U'].includes(match[2][0]) ? 'waiting' : 'unknown';
        detail.elapsed = match[3];
        detail.processName = basename(match[4]);
        detail.orphaned = detail.parentPid === 1 && detail.state !== 'zombie';
        let executable = match[4];
        if (!isAbsolute(executable) && detail.state !== 'zombie') {
          const { stdout: mappings } = await execute('/usr/sbin/lsof', ['-a', '-p', String(candidate.pid), '-d', 'txt', '-Fn'],
            { timeout: 2000, maxBuffer: 1024 * 1024 });
          executable = mappings.split('\n').filter(row => row.startsWith('n')).map(row => row.slice(1))
            .find(path => isAbsolute(path) && basename(path) === detail.processName);
        }
        if (executable && isAbsolute(executable)) {
          detail.executablePath = executable;
          const app = executable.match(/^(.*?\.app)(?:\/|$)/);
          if (app) { detail.applicationPath = app[1]; detail.applicationName = basename(app[1], '.app'); }
        }
      } catch {
        detail.detailError = 'PROCESS_DETAILS_UNAVAILABLE';
        detail.state ??= 'unknown';
      }
      result[index] = detail;
    }
  }));
  return result;
}
