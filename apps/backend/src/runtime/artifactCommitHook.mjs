import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const delay = promisify(setTimeout);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const HEADER = "# Corptie managed Artifact commit gate v2";
const LEGACY_HEADER = "# Corptie managed Artifact commit gate v1";
const MANAGED_ROOT_NAME = "corptie-managed";
const MANAGED_HOOKS = new Set(["pre-commit", "pre-merge-commit", "pre-applypatch"]);
const installations = new Map();
const GIT_HOOK_NAMES = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit",
  "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive",
  "update", "proc-receive", "post-receive", "post-update", "reference-transaction",
  "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist",
  "p4-post-changelist", "p4-pre-submit"
]);

export async function inspectArtifactCommitHook(cwd) {
  const context = await repositoryContext(cwd);
  const configured = await localHooksPath(context);
  const manifest = await readJson(context.manifestPath);
  return {
    commonGitDirectory: context.common,
    expectedHooksPath: context.hooks,
    configuredHooksPath: configured ? resolve(cwd, configured) : null,
    installed: configured ? resolve(cwd, configured) === context.hooks && manifest?.version === 2 : false,
    manifest
  };
}

// The in-process promise coalesces duplicate callers. The repository-local lock
// also serializes separate backend/app processes sharing one Git common dir.
export async function ensureArtifactCommitHook(cwd, options = {}) {
  if (!options.dbPath) throw new Error("Artifact commit hook requires the evidence database path.");
  if (options.diagnosticOnly) return inspectArtifactCommitHook(cwd);
  const context = await repositoryContext(cwd);
  if (installations.has(context.common)) return installations.get(context.common);
  const installation = withRepositoryLock(context, () => installArtifactCommitHook(context, options))
    .finally(() => installations.delete(context.common));
  installations.set(context.common, installation);
  return installation;
}

async function installArtifactCommitHook(context, { dbPath, nodePath = process.execPath }) {
  const { cwd, common, root, hooks, manifestPath, git } = context;
  const configured = await localHooksPath(context);
  const previous = configured ? resolve(cwd, configured) : resolve(cwd, await git("rev-parse", "--git-path", "hooks"));
  await mkdir(hooks, { recursive: true, mode: 0o700 });
  await ensureLocalCorptieIgnore(common);
  if (previous !== hooks && !isInside(previous, root)) await preserveRecognizedHooks(previous, hooks);

  const cli = fileURLToPath(new URL("./artifactCommitHookCli.mjs", import.meta.url));
  const installed = [];
  for (const name of MANAGED_HOOKS) {
    const hook = join(hooks, name);
    let original = previous !== hooks && !isInside(previous, root) ? await originalHook(previous, name) : null;
    if (!original) {
      const existing = await readText(hook);
      if (existing && !isManagedHook(existing)) throw new Error(`Managed Artifact hook was replaced: ${name}`);
      original = await managedOriginalHook(hook, existing);
    }
    const content = ["#!/bin/sh", HEADER, `# original-hook: ${JSON.stringify(original ?? "")}`,
      original ? `if [ -x ${quote(original)} ]; then ${quote(original)} "$@" || exit $?; fi` : "",
      `exec ${quote(nodePath)} ${quote(cli)} ${quote(resolve(dbPath))}`, ""].filter(Boolean).join("\n");
    await atomicWrite(hook, content, 0o700);
    installed.push({ name, hookPath: hook, chainedHook: original });
  }
  if (!configured || resolve(cwd, configured) !== hooks) await git("config", "--local", "core.hooksPath", hooks);
  const manifest = {
    version: 2, installedAt: new Date().toISOString(), commonGitDirectory: common,
    hooksPath: hooks, dbPath: resolve(dbPath), process: { pid: process.pid, hostname: hostname() },
    hooks: installed.map(({ name, chainedHook }) => ({ name, chainedHook }))
  };
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return { hooks: installed, dbPath: resolve(dbPath), manifest };
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

async function preserveRecognizedHooks(previous, hooks) {
  const names = await readdir(previous).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const name of names) {
    if (!GIT_HOOK_NAMES.has(name) || MANAGED_HOOKS.has(name)) continue;
    const source = join(previous, name);
    const info = await lstat(source).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info || info.isDirectory()) continue;
    const canonical = await realpath(source).catch(() => null);
    if (!canonical || isInside(canonical, hooks)) continue;
    await symlink(source, join(hooks, name)).catch(error => { if (error.code !== "EEXIST") throw error; });
  }
}

async function originalHook(directory, name) {
  const path = join(directory, name);
  const existing = await readText(path);
  if (!existing) return null;
  return isManagedHook(existing) ? managedOriginalHook(path, existing) : path;
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

function isManagedHook(content) { return content.includes(HEADER) || content.includes(LEGACY_HEADER); }
function parseOriginalHook(content) {
  const chained = content.match(/^# original-hook: (.+)$/m)?.[1];
  if (!chained) return null;
  try { return JSON.parse(chained) || null; } catch { return null; }
}

async function ensureLocalCorptieIgnore(commonGitDirectory) {
  const path = join(commonGitDirectory, "info", "exclude");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const current = await readText(path);
  if (current.split(/\r?\n/u).some(line => line.trim().toLowerCase() === "/.corptie/")) return;
  await atomicWrite(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}/.corptie/\n`, 0o600);
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
