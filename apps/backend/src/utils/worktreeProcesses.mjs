import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute, sep } from 'node:path';
const exec = promisify(execFile);
const within = (root, path) => { const r = relative(resolve(root), resolve(path)); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
const error = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

// A bounded, on-demand compatibility probe for detached Provider shell jobs.
// Open directory handles alone do not count: only process working directories.
export async function worktreeProcesses(path) {
  if (!path) return [];
  let output;
  try { output = (await exec('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (cause) { if (cause.code === 1 && !cause.stderr?.trim()) return []; throw error('TASK_BACKGROUND_INSPECTION_FAILED', '无法核对后台进程，请稍后重试。'); }
  let pid; const result = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n') && pid && within(path, line.slice(1))) result.push({ pid, path: line.slice(1) });
  }
  return result;
}

