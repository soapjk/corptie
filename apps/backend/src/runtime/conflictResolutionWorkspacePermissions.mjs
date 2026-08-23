import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

// A linked Worktree keeps its merge state in .git/worktrees/<id>, while new
// commit objects and the Integration branch ref live in the common Git dir.
// Grant only those Git namespaces: never the common worktrees parent, main,
// or another checkout path, so `git worktree remove` remains outside scope.
export async function conflictResolutionWritableRoots(
  workspace,
  inspect = inspectGitWorkspace,
  readBranch = readCurrentBranch
) {
  const path = resolve(String(workspace?.path ?? ""));
  const branchName = String(workspace?.branchName ?? await readBranch(path)).trim();
  if (!path || !branchName.startsWith("integration/")) {
    throw permissionError("RESOLUTION_WORKSPACE_INVALID", "The conflict workspace must use an Integration branch.");
  }
  const identity = await inspect(path);
  if (identity.isMain || (workspace.worktreeId && identity.worktreeId !== workspace.worktreeId)) {
    throw permissionError(
      "RESOLUTION_WORKSPACE_IDENTITY_CHANGED",
      "The conflict workspace identity changed; no writable Git metadata roots were granted."
    );
  }
  const common = identity.commonGitDirCanonicalPath;
  const gitDir = identity.gitDirCanonicalPath;
  if (!common || !gitDir || gitDir === common) {
    throw permissionError(
      "RESOLUTION_GIT_METADATA_UNAVAILABLE",
      "The dedicated Worktree Git metadata could not be isolated safely."
    );
  }
  return [...new Set([
    identity.canonicalPath ?? path,
    gitDir,
    join(common, "objects"),
    join(common, "refs", "heads", "integration"),
    join(common, "logs", "refs", "heads", "integration")
  ].map((entry) => resolve(entry)))];
}

export async function upgradeConflictResolutionWritableRoots(workspace, currentRoots, inspect, readBranch) {
  if (Array.isArray(currentRoots) && currentRoots.length > 1) return [...currentRoots];
  const path = typeof workspace?.path === "string" ? workspace.path.trim() : "";
  const knownBranch = typeof workspace?.branchName === "string" ? workspace.branchName.trim() : "";
  if (!path || !workspace?.worktreeId || (
    !knownBranch.startsWith("integration/")
    && !basename(path).startsWith("corptie-integration-worktree-")
  )) return currentRoots;
  try {
    return await conflictResolutionWritableRoots(workspace, inspect, readBranch);
  } catch (error) {
    if (error?.code === "RESOLUTION_WORKSPACE_INVALID") return currentRoots;
    throw error;
  }
}

async function readCurrentBranch(path) {
  const result = await execFileAsync("git", ["-C", path, "branch", "--show-current"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return String(result.stdout ?? "").trim();
}

function permissionError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}
