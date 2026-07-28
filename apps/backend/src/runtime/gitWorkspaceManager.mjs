import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { createGitWorkspaceSnapshot } from "../utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

export class GitWorkspaceManager {
  constructor(options) {
    this.store = options.store;
    this.transitions = options.transitions;
    this.execFile = options.execFile ?? execFileAsync;
  }

  async createWorktree(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    if (!logical.repositoryId || !logical.activeBinding?.boundCwd) {
      throw new Error("The active session is not attached to a Git repository.");
    }
    const targetPath = absolutePath(input.targetPath);
    await assertPathMissing(targetPath);
    const snapshotBefore = await createGitWorkspaceSnapshot(logical.activeBinding.boundCwd);
    if (snapshotBefore.repository.id !== logical.repositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    if (input.inventoryVersion
      && input.inventoryVersion !== snapshotBefore.inventoryVersion) {
      throw new Error("The Git worktree inventory changed; refresh it before creating a worktree.");
    }
    this.store.upsertGitWorkspaceSnapshot(snapshotBefore);
    if (snapshotBefore.worktrees.some((worktree) => resolve(worktree.path) === targetPath)) {
      throw new Error(`A Git worktree already exists at ${targetPath}.`);
    }
    const args = await this.worktreeAddArguments(input, snapshotBefore, targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await this.execFile(
        "git",
        ["-C", logical.activeBinding.boundCwd, "worktree", "add", ...args],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
      );
    } catch (error) {
      throw new Error(safeGitError(error, "git worktree add failed"));
    }
    const snapshotAfter = await createGitWorkspaceSnapshot(targetPath);
    this.store.upsertGitWorkspaceSnapshot(snapshotAfter);
    const targetCanonicalPath = await realpath(targetPath);
    const created = snapshotAfter.worktrees.find((worktree) => {
      return worktree.canonicalPath === targetCanonicalPath || resolve(worktree.path) === targetPath;
    });
    if (!created || created.availability !== "available") {
      throw new Error("Git created the worktree, but Corptie could not validate its repository identity.");
    }
    let transition = null;
    if (input.switchAfterCreate !== false) {
      transition = await this.transitions.switchWorkspace({
        logicalSessionId: logical.logicalSessionId,
        targetWorktreeId: created.worktreeId,
        activeTurnId: input.activeTurnId,
        lastCompletedTurnId: input.lastCompletedTurnId,
        dynamicToolAgentId: input.dynamicToolAgentId,
        config: input.config,
        developerInstructions: input.developerInstructions
      });
    }
    return {
      repositoryId: snapshotAfter.repository.id,
      worktree: this.store.getGitWorktree(created.worktreeId),
      inventoryVersion: snapshotAfter.inventoryVersion,
      transition
    };
  }

  async switchWorkspace(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    return this.transitions.switchWorkspace({
      ...input,
      logicalSessionId: logical.logicalSessionId
    });
  }

  requireLogicalRoute(logicalSessionId) {
    const logical = this.store.getLogicalSession(logicalSessionId);
    if (!logical?.activeBinding) {
      throw new Error(`Logical session ${logicalSessionId} has no active workspace route.`);
    }
    return logical;
  }

  async worktreeAddArguments(input, snapshot, targetPath) {
    if (input.detach === true) {
      const baseRef = await this.validatedCommitish(
        input.baseRef || "HEAD",
        snapshot.worktrees[0]?.path
      );
      return ["--detach", targetPath, baseRef];
    }
    const branch = requiredBranch(input.branch);
    await this.execFile("git", ["check-ref-format", "--branch", branch], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).catch(() => {
      throw new Error(`Invalid Git branch name: ${branch}`);
    });
    if (snapshot.worktrees.some((worktree) => {
      return worktree.availability === "available" && worktree.branchName === branch;
    })) {
      throw new Error(`Branch ${branch} is already checked out in another worktree.`);
    }
    if (input.createBranch === false) {
      await this.validatedCommitish(branch, snapshot.worktrees[0]?.path);
      return [targetPath, branch];
    }
    const baseRef = await this.validatedCommitish(
      input.baseRef || "HEAD",
      snapshot.worktrees[0]?.path
    );
    return ["-b", branch, targetPath, baseRef];
  }

  async validatedCommitish(value, cwd) {
    const ref = typeof value === "string" && value.trim() ? value.trim() : "HEAD";
    if (ref.startsWith("-") || ref.includes("\0")) throw new Error("Invalid Git base ref.");
    try {
      await this.execFile("git", ["-C", cwd, "rev-parse", "--verify", `${ref}^{commit}`], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
    } catch {
      throw new Error(`Git base ref is not a commit: ${ref}`);
    }
    return ref;
  }
}

function absolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("The worktree target path must be absolute.");
  }
  return resolve(value);
}

async function assertPathMissing(path) {
  try {
    await access(path);
    throw new Error(`The worktree target path already exists: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requiredBranch(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A branch name is required unless detach is enabled.");
  }
  return value.trim();
}

function safeGitError(error, fallback) {
  const stderr = String(error?.stderr ?? "").replace(/\s+/g, " ").trim();
  return stderr ? `${fallback}: ${stderr.slice(0, 600)}` : `${fallback}: ${error.message}`;
}
