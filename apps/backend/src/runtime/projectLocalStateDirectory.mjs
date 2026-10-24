import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { close, fstat, read as readDescriptor, fchmod } from "node:fs";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { gitScalarOutput } from "../utils/gitScalarOutput.mjs";

const require = createRequire(import.meta.url);
const scopes = new Set(["projectShared", "worktreeLocal"]);
const probes = [".gitignore", "toolset.json", "scripts/probe", "runtime/probe", "artifacts/probe", "tasks/probe", "sessions/probe"]
  .map(path => `.corptie/${path}`);
const failure = (code, message) => Object.assign(new Error(message), { code, statusCode: 409, status: 409 });
const digest = value => createHash("sha256").update(value).digest("hex");

function native() {
  const bridge = require("../../native/corptie_native.node");
  if (typeof bridge.localStateDirectory !== "function" || typeof bridge.rollbackLocalStateDirectory !== "function") {
    throw failure("LOCAL_STATE_NATIVE_UNAVAILABLE", "Rebuild the native local-directory safety bridge.");
  }
  return bridge;
}

async function git(root, args, input = null) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return new Promise((accept, reject) => {
    const child = execFile("git", ["-c", "core.fsmonitor=false", "-C", root, ...args],
      { env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(error) : accept({ stdout, stderr }));
    if (input !== null) child.stdin.end(input);
  });
}

async function context(root, scope) {
  if (!scopes.has(scope) || !isAbsolute(root ?? "")) throw failure("LOCAL_STATE_SCOPE_INVALID", "An explicit local directory scope and absolute bound root are required.");
  const info = await lstat(root, { bigint: true });
  const canonical = await realpath(root);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(root)) {
    throw failure("LOCAL_STATE_PATH_UNSAFE", "The bound project root changed or is not a canonical directory.");
  }
  let isGit = true;
  try {
    const result = await git(canonical, ["rev-parse", "--show-toplevel"]);
    if (await realpath(gitScalarOutput(result.stdout)) !== canonical) throw failure("LOCAL_STATE_ROOT_INVALID", "Use the bound Worktree root, not a repository subdirectory.");
  } catch (error) {
    if (error.code !== 128 || await lstat(join(canonical, ".git")).then(() => true, missing => {
      if (missing.code === "ENOENT") return false;
      throw missing;
    })) throw error;
    isGit = false;
  }
  return { root: canonical, scope, isGit, rootDevice: String(info.dev), rootInode: String(info.ino) };
}

function read(bound, create = false, expected = null) {
  const result = native().localStateDirectory(bound.root, create, bound.rootDevice, bound.rootInode,
    expected?.directoryDevice, expected?.directoryInode);
  if (result.errorCode) {
    const error = failure(result.errorCode, `Cannot safely prepare .corptie (${result.errorCode}). Check for symbolic links, wrong types, permissions, existing content and ignore rules.`);
    error.localStateReceipt = { ...bound, nativeReceipt: result };
    throw error;
  }
  return result;
}

function ignorePolicy(result) {
  if (!result.ignoreExists) throw failure("LOCAL_STATE_IGNORE_MISSING", "The local .corptie ignore file is missing; use explicit repair.");
  const lines = result.ignoreText.split(/\r?\n/u).map(value => value.trim()).filter(value => value && !value.startsWith("#"));
  if (!lines.some(line => ["*", "**", "/**"].includes(line)) || lines.some(line => line.startsWith("!"))) {
    throw failure("LOCAL_STATE_IGNORE_CONFLICT", "Existing .corptie/.gitignore does not unconditionally protect local data. It was not changed.");
  }
}

async function untracked(bound) {
  if (!bound.isGit) return;
  const { stdout } = await git(bound.root, ["ls-files", "--cached", "-z", "--", ":(icase).corptie"]);
  if (stdout) throw failure("LOCAL_STATE_TRACKED", ".corptie contains Git-tracked files. Untrack them explicitly before using private local state.");
}

async function ignored(bound) {
  if (!bound.isGit) return;
  const { stdout } = await git(bound.root, ["check-ignore", "--no-index", "-z", "--stdin"], `${probes.join("\0")}\0`);
  const found = new Set(stdout.split("\0").filter(Boolean));
  if (probes.some(path => !found.has(path))) throw failure("LOCAL_STATE_NOT_IGNORED", "Local Corptie files are not fully ignored by Git.");
  const others = await git(bound.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".corptie"]);
  if (others.stdout) throw failure("LOCAL_STATE_NOT_IGNORED", "Existing local Corptie content is visible to Git.");
}

function same(before, after) {
  for (const field of ["rootDevice", "rootInode", "directoryDevice", "directoryInode", "ignoreDevice", "ignoreInode", "ignoreText"]) {
    if (before[field] !== after[field]) throw failure("LOCAL_STATE_PATH_CHANGED", "Local directory identity or ignore rules changed during verification.");
  }
}

/** No fallback to another Worktree or to the global Data Root is permitted. */
export async function ensureProjectLocalState(root, { scope } = {}) {
  const bound = await context(root, scope);
  await untracked(bound);
  const before = read(bound);
  if (before.ignoreExists) ignorePolicy(before);
  let receipt;
  try {
    const prepared = read(bound, true, before.exists ? before : null);
    receipt = { schemaVersion: 1, ...bound, nativeReceipt: prepared };
    ignorePolicy(prepared);
    await untracked(bound);
    await ignored(bound);
    same(prepared, read(bound));
    return { ...receipt, state: "ready", gitStatus: bound.isGit ? "ignored-untracked" : "notApplicable",
      ignoreHash: digest(prepared.ignoreText) };
  } catch (error) {
    receipt ??= error.localStateReceipt;
    if (receipt) {
      try {
        const cleanup = rollbackProjectLocalState(receipt);
        if (cleanup.retained) error.localStateRecovery = { root: bound.root, code: "LOCAL_STATE_ADOPTED" };
      } catch (cleanupError) { error.localStateRecovery = { root: bound.root, code: cleanupError.code }; }
    }
    throw error;
  }
}

export async function verifyProjectLocalState(receipt) {
  const bound = await context(receipt.root, receipt.scope);
  const current = read(bound);
  same(receipt.nativeReceipt, current);
  ignorePolicy(current);
  await untracked(bound);
  await ignored(bound);
  same(current, read(bound));
  return { state: "ready", scope: bound.scope, gitStatus: bound.isGit ? "ignored-untracked" : "notApplicable", ignoreHash: digest(current.ignoreText) };
}

export function rollbackProjectLocalState(receipt) {
  const result = native().rollbackLocalStateDirectory(receipt.root, receipt.nativeReceipt);
  if (result.errorCode) throw failure(result.errorCode, "Local directory cleanup could not be proved safe; retained data requires inspection.");
  return { retained: result.retained };
}

export function writeProjectLocalFile(receipt, path, content) {
  if (!scopes.has(receipt.scope) || !path || path.includes("\\") || path.includes("\0")
      || path.split("/").some(part => !part || [".", "..", ".git", ".gitignore"].includes(part.toLowerCase()))) {
    throw failure("LOCAL_STATE_PATH_INVALID", "Use a safe local-state-relative path, excluding Git control files.");
  }
  const bridge = native();
  if (typeof bridge.writeLocalStateFile !== "function") throw failure("LOCAL_STATE_NATIVE_UNAVAILABLE", "Bound local file publication is unavailable.");
  try { return bridge.writeLocalStateFile(receipt.root, path, content, receipt.nativeReceipt); }
  catch (error) {
    const code = /^([A-Z][A-Z0-9_]{1,80}):/.exec(error.message ?? "")?.[1];
    if (code) error.code = code;
    throw error;
  }
}

export async function readProjectLocalFile(receipt, path, { executable = false, expectedContent = null, maximumBytes = 131072 } = {}) {
  if (!path || path.includes("\\") || path.includes("\0") || path.split("/").some(part => !part || [".", "..", ".git"].includes(part.toLowerCase()))) {
    throw failure("LOCAL_STATE_PATH_INVALID", "Unsafe local file path.");
  }
  const fd = native().openLocalStateFile(receipt.root, path, receipt.nativeReceipt);
  try {
    const info = await promisify(fstat)(fd, { bigint: true });
    if (info.size > BigInt(maximumBytes)) throw failure("LOCAL_STATE_FILE_TOO_LARGE", "Local definition exceeds its size limit.");
    const content = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await promisify(readDescriptor)(fd, content, offset, content.length - offset, offset);
      if (!bytesRead) throw failure("LOCAL_STATE_FILE_CHANGED", "Definition changed while reading.");
      offset += bytesRead;
    }
    const after = await promisify(fstat)(fd, { bigint: true });
    if (info.size !== after.size || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) {
      throw failure("LOCAL_STATE_FILE_CHANGED", "Definition changed while reading.");
    }
    if (expectedContent && !content.equals(expectedContent)) throw failure("TOOLSET_SNAPSHOT_INVALID", "Existing snapshot content differs; it was not changed.");
    if (executable) await promisify(fchmod)(fd, 0o500);
    return { content, executable: Boolean(info.mode & 0o111n) };
  } finally { await promisify(close)(fd); }
}

/** Read-only diagnosis is never an implicit repair or a toolset generator. */
export async function inspectProjectLocalState(root, { scope } = {}) {
  try {
    const bound = await context(root, scope);
    await untracked(bound);
    const result = read(bound);
    if (!result.exists) return { state: "missing", scope };
    ignorePolicy(result);
    await ignored(bound);
    same(result, read(bound));
    return { state: "ready", scope, gitStatus: bound.isGit ? "ignored-untracked" : "notApplicable" };
  } catch (error) {
    return { state: error.code === "LOCAL_STATE_PERMISSION_DENIED" ? "permissionDenied" : "conflict",
      scope, code: error.code ?? "LOCAL_STATE_UNAVAILABLE", message: error.message };
  }
}
