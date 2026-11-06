import { randomUUID } from "node:crypto";
import { copyFile, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

function relativeInside(root, path) {
  const value = relative(root, path);
  return value && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value) ? value : null;
}

// Copy only this thread's native rollout. The original is still the authority
// until the destination App Server resumes the same ID and the registry commits.
export async function stageNativeCodexThread({ sourceHome, targetHome, threadId, rolloutPath }) {
  if (typeof rolloutPath !== "string" || !isAbsolute(rolloutPath)) throw invalidRollout();
  const sourceRoot = await realpath(sourceHome);
  const source = await realpath(rolloutPath);
  const suffix = relativeInside(sourceRoot, source);
  if (!suffix || !["sessions", "archived_sessions"].includes(suffix.split(sep)[0])
    || !suffix.endsWith(`-${threadId}.jsonl`) || !(await stat(source)).isFile()) throw invalidRollout();
  const targetRoot = await realpath(targetHome);
  const target = join(targetRoot, suffix);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(target)) !== dirname(target)) throw invalidRollout();
  const temporary = `${target}.${randomUUID()}.staging`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

function invalidRollout() {
  return Object.assign(new Error("无法安全读取原生 Codex 线程文件，旧线程保持原位。"), {
    code: "CODEX_NATIVE_THREAD_STORAGE_UNAVAILABLE", dispatchState: "not_dispatched"
  });
}
