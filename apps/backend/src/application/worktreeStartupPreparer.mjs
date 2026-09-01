import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Programmatic Git/Workspace preparation; it has no Provider dependency. */
export class WorktreeStartupPreparer {
  constructor(options = {}) {
    this.store = options.store;
    this.ensureWorkspace = options.ensureWorkspace;
    this.execGit = options.execGit ?? runGit;
    if (!this.store) throw new TypeError("WorktreeStartupPreparer requires a Store.");
    if (typeof this.ensureWorkspace !== "function") throw new TypeError("WorktreeStartupPreparer requires ensureWorkspace().");
  }

  async prepare(input) {
    const task = input?.task ?? this.store.getTask(input?.taskId);
    if (!task || task.id !== input.taskId || task.main_workspace_id !== input.repositoryId) {
      throw coded("START_REFERENCE_INVALID", "Task Repository binding changed before Worktree preparation.", false);
    }
    const owned = this.store.selectOne(
      `SELECT worktree_id FROM git_worktrees
       WHERE repository_id=? AND created_by_startup_operation_id=? AND dedicated=1
       ORDER BY rowid DESC LIMIT 1`,
      [input.repositoryId, input.startupOperationId]
    );
    const prepared = owned ? this.store.getGitWorktree(owned.worktree_id) : null;
    const workspace = prepared ? {
      worktreeId: prepared.worktreeId,
      path: prepared.canonicalPath || prepared.path,
      branchName: prepared.branchName,
      headOid: prepared.headOid,
      isDetached: prepared.isDetached,
      inventoryVersion: prepared.inventoryVersion,
      reused: true
    } : await this.ensureWorkspace({ task, session: null });
    if (workspace.workspaceMode === "unborn-main") {
      throw coded("START_SOURCE_IDENTITY_UNAVAILABLE", "Unborn Repository has no commit/tree for a dedicated Work Session.", false);
    }
    let inventory = this.store.getGitWorktree(workspace.worktreeId);
    if (!inventory) throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Prepared Worktree was not registered.", true);
    if (workspace.reused === true) {
      if (inventory.createdByStartupOperationId !== input.startupOperationId || inventory.dedicated !== true) {
        throw coded("START_WORKTREE_COLLISION", "Existing Worktree is not owned by this startup operation.", false);
      }
    } else {
      this.store.db.run(
        `UPDATE git_worktrees SET dedicated=1, created_by_startup_operation_id=?
         WHERE worktree_id=? AND repository_id=? AND created_by_startup_operation_id IS NULL`,
        [input.startupOperationId, workspace.worktreeId, input.repositoryId]
      );
      const owned = this.store.getGitWorktree(workspace.worktreeId);
      if (owned?.createdByStartupOperationId !== input.startupOperationId || owned.dedicated !== true) {
        throw coded("START_WORKTREE_COLLISION", "Worktree ownership could not be claimed by this startup operation.", false);
      }
      this.store.scheduleSave();
    }
    return this.#verify({
      operationId: input.startupOperationId,
      repositoryId: input.repositoryId,
      workspace,
      reused: workspace.reused === true
    });
  }

  async inspect({ operation, allocation }) {
    const row = this.store.getGitWorktree(allocation.worktreeId);
    if (!row) throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree is absent from the authoritative inventory.", true);
    return this.#verify({
      operationId: operation.startup_operation_id,
      repositoryId: allocation.repositoryId,
      workspace: {
        worktreeId: row.worktreeId,
        path: row.canonicalPath || row.path,
        branchName: row.branchName,
        headOid: row.headOid,
        isDetached: row.isDetached,
        inventoryVersion: row.inventoryVersion
      },
      reused: allocation.reused === true
    });
  }

  async #verify({ operationId, repositoryId, workspace, reused }) {
    const repository = this.store.getGitRepository(repositoryId);
    const inventory = this.store.getGitWorktree(workspace.worktreeId);
    if (!repository || !inventory || inventory.repositoryId !== repositoryId
      || inventory.availability !== "available" || inventory.isMain === true
      || inventory.dedicated !== true || inventory.createdByStartupOperationId !== operationId) {
      throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Dedicated Worktree inventory is unavailable or belongs to another Repository.", true);
    }
    const canonicalWorktreePath = await canonical(workspace.path);
    const inventoryPath = await canonical(inventory.canonicalPath || inventory.path);
    if (canonicalWorktreePath !== inventoryPath) {
      throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree canonical path differs from Store inventory.", true);
    }
    for (const other of this.store.listGitWorktrees(repositoryId)) {
      if (other.worktreeId === inventory.worktreeId || other.availability !== "available") continue;
      const otherPath = await canonical(other.canonicalPath || other.path);
      if (pathContains(otherPath, canonicalWorktreePath)) {
        throw coded("START_WORKTREE_COLLISION", "Dedicated Worktree is nested inside another Git Worktree.", false);
      }
    }
    const commonGitDirText = await this.execGit(canonicalWorktreePath, ["rev-parse", "--git-common-dir"]);
    const commonGitDir = await canonical(resolve(canonicalWorktreePath, commonGitDirText.trim()));
    const registeredCommonGitDir = await canonical(repository.commonGitDirCanonicalPath);
    if (commonGitDir !== registeredCommonGitDir) {
      throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree common Git directory differs from the registered Repository.", true);
    }
    const sourceCommitOid = (await this.execGit(canonicalWorktreePath, ["rev-parse", "HEAD"])).trim();
    const sourceTreeOid = (await this.execGit(canonicalWorktreePath, ["rev-parse", "HEAD^{tree}"])).trim();
    if (!fullOid(sourceCommitOid) || !fullOid(sourceTreeOid)) {
      throw coded("START_SOURCE_IDENTITY_UNAVAILABLE", "Repository has no verifiable source commit/tree.", false);
    }
    const detached = inventory.isDetached === true || workspace.isDetached === true;
    const branch = inventory.branchName ?? workspace.branchName ?? null;
    if (!detached && !branch) throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Branch Worktree has no branch identity.", true);
    return {
      repositoryId,
      worktreeId: inventory.worktreeId,
      canonicalWorktreePath,
      headIdentity: detached
        ? { kind: "detached", commitOid: sourceCommitOid }
        : { kind: "branch", branch },
      sourceCommitOid,
      sourceTreeOid,
      baseRef: null,
      repositoryInventoryVersion: inventory.inventoryVersion,
      workspaceResourceVersion: inventory.resourceVersion,
      createdByStartupOperationId: operationId,
      reused
    };
  }
}

async function runGit(cwd, args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000
  });
  return stdout;
}

async function canonical(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree paths must be absolute.", false);
  }
  try { return await realpath(resolve(path)); } catch (error) {
    throw coded("START_REPOSITORY_UNAVAILABLE", `Registered Workspace is inaccessible: ${dirname(path)}.`, true, error);
  }
}

function fullOid(value) { return /^[0-9a-f]{40,64}$/i.test(String(value ?? "")); }

function pathContains(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function coded(code, message, retryable, cause = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  error.retryable = retryable;
  if (cause) error.cause = cause;
  return error;
}
