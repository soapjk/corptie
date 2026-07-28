import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseGitWorktreePorcelain(value) {
  const input = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const records = [];
  let current = null;

  for (const field of input.split("\0")) {
    if (!field) {
      if (current) {
        records.push(current);
        current = null;
      }
      continue;
    }

    const separatorIndex = field.indexOf(" ");
    const key = separatorIndex >= 0 ? field.slice(0, separatorIndex) : field;
    const data = separatorIndex >= 0 ? field.slice(separatorIndex + 1) : "";

    if (key === "worktree") {
      if (current) records.push(current);
      current = emptyWorktreeRecord(data);
      continue;
    }

    if (!current) continue;

    switch (key) {
      case "HEAD":
        current.headOid = data || null;
        break;
      case "branch":
        current.branchRef = data || null;
        current.branchName = shortBranchName(data);
        break;
      case "detached":
        current.isDetached = true;
        break;
      case "bare":
        current.isBare = true;
        break;
      case "locked":
        current.isLocked = true;
        current.lockReason = data || null;
        break;
      case "prunable":
        current.isPrunable = true;
        current.pruneReason = data || null;
        break;
      default:
        current.unknownFields.push({ key, value: data || null });
        break;
    }
  }

  if (current) records.push(current);
  return records;
}

export async function listGitWorktrees(workingDirectory, options = {}) {
  const run = options.execFile ?? execFileAsync;
  const result = await run(
    "git",
    ["-C", workingDirectory, "worktree", "list", "--porcelain", "-z"],
    {
      encoding: null,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024
    }
  );
  return parseGitWorktreePorcelain(result.stdout);
}

export async function inspectGitWorkspace(workingDirectory, options = {}) {
  const run = options.execFile ?? execFileAsync;
  const resolveRealpath = options.realpath ?? realpath;
  const requestedPath = resolve(String(workingDirectory));
  const [topLevel, gitDir, commonGitDir] = await Promise.all([
    readGitPath(run, requestedPath, "--show-toplevel"),
    readGitPath(run, requestedPath, "--git-dir"),
    readGitPath(run, requestedPath, "--git-common-dir")
  ]);
  const [canonicalPath, gitDirCanonicalPath, commonGitDirCanonicalPath] = await Promise.all([
    resolveRealpath(topLevel),
    resolveRealpath(gitDir),
    resolveRealpath(commonGitDir)
  ]);
  const repositoryId = stableId("repository", commonGitDirCanonicalPath);
  return {
    repositoryId,
    worktreeId: stableId("worktree", `${repositoryId}\0${gitDirCanonicalPath}`),
    path: topLevel,
    canonicalPath,
    gitDirCanonicalPath,
    commonGitDirCanonicalPath,
    isMain: gitDirCanonicalPath === commonGitDirCanonicalPath
  };
}

export async function createGitWorkspaceSnapshot(workingDirectory, options = {}) {
  const inspectedAt = options.inspectedAt ?? new Date().toISOString();
  const anchor = await inspectGitWorkspace(workingDirectory, options);
  const inventory = await listGitWorktrees(workingDirectory, options);
  const worktrees = [];

  for (const record of inventory) {
    try {
      const identity = await inspectGitWorkspace(record.path, options);
      if (identity.repositoryId !== anchor.repositoryId) {
        throw new Error(`Worktree ${record.path} resolved to another repository`);
      }
      worktrees.push({
        ...record,
        ...identity,
        availability: "available",
        observedAt: inspectedAt
      });
    } catch (error) {
      worktrees.push({
        ...record,
        repositoryId: anchor.repositoryId,
        worktreeId: stableId("missing-worktree", `${anchor.repositoryId}\0${record.path}`),
        canonicalPath: null,
        gitDirCanonicalPath: null,
        commonGitDirCanonicalPath: anchor.commonGitDirCanonicalPath,
        isMain: false,
        availability: record.isPrunable ? "missing" : "invalid",
        inspectionError: error.message,
        observedAt: inspectedAt
      });
    }
  }

  const inventoryVersion = createHash("sha256")
    .update(JSON.stringify(worktrees.map(worktreeSnapshotFingerprint)))
    .digest("hex");
  return {
    repository: {
      id: anchor.repositoryId,
      commonGitDirCanonicalPath: anchor.commonGitDirCanonicalPath,
      discoveredAt: inspectedAt,
      lastValidatedAt: inspectedAt
    },
    worktrees,
    inventoryVersion,
    observedAt: inspectedAt
  };
}

function emptyWorktreeRecord(path) {
  return {
    path,
    headOid: null,
    branchRef: null,
    branchName: null,
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
    isPrunable: false,
    pruneReason: null,
    unknownFields: []
  };
}

function shortBranchName(ref) {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref || null;
}

async function readGitPath(run, workingDirectory, flag) {
  const result = await run(
    "git",
    ["-C", workingDirectory, "rev-parse", "--path-format=absolute", flag],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  const value = stripTrailingLineEnding(String(result.stdout ?? ""));
  if (!value) throw new Error(`git rev-parse ${flag} returned an empty path`);
  return value;
}

function stripTrailingLineEnding(value) {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function stableId(namespace, value) {
  return `${namespace}:${createHash("sha256").update(value).digest("hex")}`;
}

function worktreeSnapshotFingerprint(worktree) {
  return {
    worktreeId: worktree.worktreeId,
    path: worktree.path,
    gitDirCanonicalPath: worktree.gitDirCanonicalPath,
    availability: worktree.availability,
    headOid: worktree.headOid,
    branchRef: worktree.branchRef,
    isDetached: worktree.isDetached,
    isLocked: worktree.isLocked,
    isPrunable: worktree.isPrunable
  };
}
