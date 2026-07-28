import { execFile } from "node:child_process";
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
