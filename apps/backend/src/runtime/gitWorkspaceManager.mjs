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

  async sessionDeletionPlan(logicalSessionId) {
    const logical = this.requireLogicalRoute(logicalSessionId);
    const activeCwd = logical.activeBinding?.boundCwd;
    if (!logical.repositoryId || !activeCwd || !logical.activeBinding?.worktreeId) {
      return { requiresWorktreeMerge: false };
    }

    const snapshot = await createGitWorkspaceSnapshot(activeCwd);
    if (snapshot.repository.id !== logical.repositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    this.store.upsertGitWorkspaceSnapshot(snapshot);
    const source = snapshot.worktrees.find((worktree) => {
      return worktree.worktreeId === logical.activeBinding.worktreeId;
    });
    if (!source || source.availability !== "available" || source.isMain) {
      return { requiresWorktreeMerge: false };
    }
    const main = snapshot.worktrees.find((worktree) => worktree.isMain);
    if (!main || main.availability !== "available") {
      throw new Error("The repository's main worktree is unavailable.");
    }
    if (main.branchName !== "main") {
      throw new Error(`The repository's main worktree is on ${main.branchName || "a detached HEAD"}, not main.`);
    }

    const status = await this.gitOutput(source.path, ["status", "--short"]);
    const diffStat = await this.gitOutput(source.path, ["diff", "--stat", "HEAD"]);
    return {
      requiresWorktreeMerge: true,
      repositoryId: snapshot.repository.id,
      sourceWorktreeId: source.worktreeId,
      sourcePath: source.path,
      sourceBranch: source.branchName,
      mainWorktreeId: main.worktreeId,
      mainPath: main.path,
      mainBranch: main.branchName,
      hasUncommittedChanges: Boolean(status.trim()),
      statusSummary: status.trim(),
      diffStat: diffStat.trim()
    };
  }

  async mergeSessionWorktreeIntoMain(input) {
    const plan = await this.sessionDeletionPlan(input.logicalSessionId);
    if (!plan.requiresWorktreeMerge) {
      throw new Error("The Session is not bound to a non-main Git worktree.");
    }
    const mainStatus = await this.gitOutput(plan.mainPath, ["status", "--porcelain=v1"]);
    if (mainStatus.trim()) {
      throw new Error("The main worktree has uncommitted changes. Clean it before merging this Session's worktree.");
    }

    let committed = false;
    let commitMessage = null;
    if (plan.hasUncommittedChanges) {
      commitMessage = requiredCommitMessage(input.commitMessage);
      try {
        await this.runGit(plan.sourcePath, ["add", "--all"]);
        await this.runGit(plan.sourcePath, ["commit", "-m", commitMessage]);
        committed = true;
      } catch (error) {
        throw new Error(safeGitError(error, "Could not commit the Session worktree changes"));
      }
    }

    const sourceHead = (await this.gitOutput(plan.sourcePath, ["rev-parse", "--verify", "HEAD"])).trim();
    try {
      await this.runGit(plan.mainPath, ["merge", "--no-ff", "--no-edit", sourceHead]);
    } catch (error) {
      await this.runGit(plan.mainPath, ["merge", "--abort"]).catch(() => {});
      throw new Error(safeGitError(error, "Could not merge the Session worktree into main"));
    }
    const mainHead = (await this.gitOutput(plan.mainPath, ["rev-parse", "--verify", "HEAD"])).trim();
    return {
      merged: true,
      committed,
      commitMessage,
      sourceHead,
      mainHead,
      sourceBranch: plan.sourceBranch,
      sourcePath: plan.sourcePath,
      mainPath: plan.mainPath
    };
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

  async runGit(cwd, arguments_) {
    return this.execFile("git", ["-C", cwd, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
  }

  async gitOutput(cwd, arguments_) {
    try {
      const result = await this.runGit(cwd, arguments_);
      return String(result?.stdout ?? "");
    } catch (error) {
      throw new Error(safeGitError(error, `git ${arguments_[0]} failed`));
    }
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

function requiredCommitMessage(value) {
  const message = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!message) throw new Error("The Session did not generate a usable commit message.");
  if (message.includes("\0")) throw new Error("The generated commit message is invalid.");
  return message.slice(0, 120);
}

function safeGitError(error, fallback) {
  const stderr = String(error?.stderr ?? "").replace(/\s+/g, " ").trim();
  return stderr ? `${fallback}: ${stderr.slice(0, 600)}` : `${fallback}: ${error.message}`;
}
