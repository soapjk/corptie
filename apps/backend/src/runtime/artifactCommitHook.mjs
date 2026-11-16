import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const delay = promisify(setTimeout);
const HEADER = "# Corptie managed Artifact commit gate v2";
const LEGACY_HEADER = "# Corptie managed Artifact commit gate v1";
const MANAGED_ROOT_NAME = "corptie-managed";
const MANAGED_HOOKS = new Set(["pre-commit", "pre-merge-commit", "pre-applypatch"]);
const installations = new Map();
const GIT_HOOK_NAMES = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit"
]);
// Retirement only: never install repository hooks or bind Git to a runtime/DB.
export async function cleanupArtifactCommitHook(cwd) {
  const context = await repositoryContext(cwd);
  if (installations.has(context.common)) return installations.get(context.common);
  const cleanup = withRepositoryLock(context, async () => {
    const configured = await localHooksPath(context);
    const configuredPath = configured ? resolve(cwd, configured) : join(context.common, "hooks");
    const active = await realpath(configuredPath).catch(error => { if (error.code === "ENOENT") return configuredPath; throw error; });
    const directories = new Set([context.hooks, active, join(context.common, "hooks")]);
    const restored = [];
    for (const directory of directories) {
      for (const name of MANAGED_HOOKS) {
        const path = join(directory, name);
        const info = await lstat(path).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!info?.isFile()) continue;
        const content = await readText(path);
        if (!isManagedHook(content)) continue;
        const original = await managedOriginalHook(path, content);
        // Preserve the original file and mode; replace only our own wrapper.
        if (original) {
          const temporary = `${path}.${randomUUID()}.tmp`;
          await symlink(original, temporary);
          await rename(temporary, path);
          restored.push(await realpath(dirname(original)));
        } else await rm(path);
      }
    }
    // Only our known private path is evidence that we set this config. Unknown
    // custom paths and files stay in place. Old manifests did not record the
    // prior config scope, so infer a path only from surviving original hooks.
    if (active === context.hooks) {
      const names = await readdir(active).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
      const origins = new Set(restored);
      let allOriginal = true;
      for (const name of names.filter(name => GIT_HOOK_NAMES.has(name))) {
        const path = join(active, name);
        const info = await lstat(path);
        if (!info.isSymbolicLink()) { allOriginal = false; break; }
        const target = await realpath(path).catch(() => null);
        if (!target || isInside(target, context.root)) { allOriginal = false; break; }
        origins.add(dirname(target));
      }
      if (allOriginal && origins.size <= 1) {
        const original = [...origins][0];
        if (original && original !== join(context.common, "hooks")) await context.git("config", "--local", "core.hooksPath", original);
        else await context.git("config", "--local", "--unset-all", "core.hooksPath").catch(error => { if (error.code !== 5) throw error; });
      }
    }
    return { cleaned: true };
  }).finally(() => installations.delete(context.common));
  installations.set(context.common, cleanup);
  return cleanup;
}

async function repositoryContext(cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = async (...args) => {
    try {
      return (await run("git", ["-C", cwd, ...args], { env, encoding: "utf8", timeout: 10000 })).stdout.trim();
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      const wrapped = new Error(String(error.stderr || error.message).trim());
      wrapped.code = error.code;
      throw wrapped;
    }
  };
  const unresolved = resolve(cwd, await git("rev-parse", "--git-common-dir"));
  const common = await realpath(unresolved).catch(() => unresolved);
  const root = join(common, MANAGED_ROOT_NAME);
  return { cwd, common, root, hooks: join(root, "hooks"), manifestPath: join(root, "manifests", "artifact-hook.json"), lockPath: join(root, "locks", "artifact-hook-install.lock"), git };
}

async function localHooksPath(context) {
  return context.git("config", "--local", "--get", "core.hooksPath")
    .catch(error => error.code === 1 ? "" : Promise.reject(error));
}

async function withRepositoryLock(context, operation) {
  await mkdir(dirname(context.lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      await mkdir(context.lockPath, { mode: 0o700 });
      await atomicWrite(join(context.lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`, 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await recoverStaleLock(context.lockPath)) continue;
      if (Date.now() >= deadline) {
        const lockError = new Error("Timed out waiting for the repository Artifact hook installation lock.");
        lockError.code = "ARTIFACT_HOOK_INSTALL_LOCK_TIMEOUT";
        throw lockError;
      }
      await delay(50);
    }
  }
  try { return await operation(); }
  finally { await rm(context.lockPath, { recursive: true, force: true }); }
}

async function recoverStaleLock(lockPath) {
  const owner = await readJson(join(lockPath, "owner.json"));
  if (!owner || owner.hostname !== hostname() || !Number.isInteger(owner.pid)) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) {
    if (error.code !== "ESRCH") return false;
    const quarantine = `${lockPath}.stale.${Date.now()}.${randomUUID()}`;
    try { await rename(lockPath, quarantine); }
    catch (renameError) { return renameError.code === "ENOENT"; }
    await rm(quarantine, { recursive: true, force: true });
    return true;
  }
}

// Older installers could accidentally record their own wrapper as the
// original hook. Following that entry recursively exhausts the process table
// before the Artifact gate ever runs. Collapse managed-wrapper chains to the
// first real hook and discard self-references or cycles during migration.
async function managedOriginalHook(path, content, visited = new Set()) {
  const wrapper = resolve(path);
  if (visited.has(wrapper)) return null;
  visited.add(wrapper);
  const chained = parseOriginalHook(content);
  if (!chained) return null;
  const target = resolve(dirname(wrapper), chained);
  if (visited.has(target)) return null;
  const targetContent = await readText(target);
  if (!targetContent) return null;
  return isManagedHook(targetContent)
    ? managedOriginalHook(target, targetContent, visited)
    : target;
}

function isManagedHook(content) {
  const lines = content.trimEnd().split("\n");
  return lines[0] === "#!/bin/sh" && [HEADER, LEGACY_HEADER].includes(lines[1])
    && /^# original-hook: /u.test(lines[2] ?? "")
    && lines.length >= 4 && lines.length <= 5
    && /^exec .*artifactCommitHookCli\.mjs/u.test(lines.at(-1))
    && (lines.length === 4 || /^if \[ -x .*; then .* "\$@" \|\| exit \$\?; fi$/u.test(lines[3]));
}
function parseOriginalHook(content) {
  const chained = content.match(/^# original-hook: (.+)$/m)?.[1];
  if (!chained) return null;
  try { return JSON.parse(chained) || null; } catch { return null; }
}

async function atomicWrite(path, content, mode) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function readText(path) { return readFile(path, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error)); }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
function isInside(path, directory) {
  const relative = path.slice(directory.length);
  return path === directory || (path.startsWith(directory) && (relative.startsWith("/") || relative.startsWith("\\")));
}
