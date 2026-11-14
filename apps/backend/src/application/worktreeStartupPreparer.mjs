import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { TaskWorktreeHierarchyService } from "./taskWorktreeHierarchyService.mjs";
import { ensureProjectLocalState } from "../runtime/projectLocalStateDirectory.mjs";
import { gitScalarOutput } from "../utils/gitScalarOutput.mjs";
import { measureStartup } from "../utils/startupTiming.mjs";

const execFile = promisify(execFileCallback);

/** Programmatic Git/Workspace preparation; it has no Provider dependency. */
export class WorktreeStartupPreparer {
  constructor(options = {}) {
    this.store = options.store;
    this.ensureWorkspace = options.ensureWorkspace;
    this.execGit = options.execGit ?? runGit;
    this.hierarchy = new TaskWorktreeHierarchyService({ store:this.store, execGit:this.execGit });
    if (!this.store) throw new TypeError("WorktreeStartupPreparer requires a Store.");
    if (typeof this.ensureWorkspace !== "function") throw new TypeError("WorktreeStartupPreparer requires ensureWorkspace().");
  }

  async prepare(input) {
    const task = input?.task ?? this.store.getTask(input?.taskId);
    if (!task || task.id !== input.taskId
      || this.store.getTaskWorkspaceContext(task)?.repository?.id !== input.repositoryId) {
      throw coded("START_REFERENCE_INVALID", "Task Repository binding changed before Worktree preparation.", false);
    }
    const timing = input.startupTiming;
    if (task.parent_task_id) {
      const workspace = await this.ensureWorkspace({ task, session: null, startupTiming: timing });
      if (!workspace?.worktreeId || !workspace.path || !workspace.branchName) {
        throw coded("START_WORKTREE_INVENTORY_MISMATCH", "子任务工作区未准备完成，尚未开始执行；可重试原派发。", true);
      }
      if (!this.store.getGitWorktree(workspace.worktreeId)) {
        throw coded("START_WORKTREE_INVENTORY_MISMATCH", "子任务工作区未登记，尚未开始执行；可重试原派发。", true);
      }
      this.store.db.run(`UPDATE git_worktrees SET dedicated=1,created_by_startup_operation_id=? WHERE worktree_id=?`,
        [input.startupOperationId, workspace.worktreeId]);
      this.store.scheduleSave();
      return { repositoryId: input.repositoryId, worktreeId: workspace.worktreeId,
        canonicalWorktreePath: workspace.path, headIdentity: { kind: "branch", branch: workspace.branchName },
        sourceCommitOid: workspace.headOid, sourceTreeOid: workspace.sourceTreeOid,
        repositoryInventoryVersion: workspace.inventoryVersion, workspaceResourceVersion: 1,
        createdByStartupOperationId: input.startupOperationId, reused: workspace.reused === true,
        baseContext: workspace.baseContext };
    }
    const baseContext = null;
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
    } : await measureStartup(timing, "worktree.ensure-workspace", span => this.ensureWorkspace({ task, session: null,
      ...(span ? { startupTiming: span } : {}), ...(baseContext ? { baseContext } : {}) }));
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
    return measureStartup(timing, "worktree.verify-prepared", span => this.#verify({
      operationId: input.startupOperationId,
      repositoryId: input.repositoryId,
      workspace,
      baseContext,
      reused: workspace.reused === true, startupTiming: span
    }));
  }

  async inspect({ operation, allocation, startupTiming = null }) {
    const row = this.store.getGitWorktree(allocation.worktreeId);
    if (!row) throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree is absent from the authoritative inventory.", true);
    return this.#verify({
      operationId: operation.startup_operation_id,
      repositoryId: allocation.repositoryId,
      baseContext: operation.worktree_base_context_json ? JSON.parse(operation.worktree_base_context_json) : allocation.baseContext ?? null,
      workspace: {
        worktreeId: row.worktreeId,
        path: row.canonicalPath || row.path,
        branchName: row.branchName,
        headOid: row.headOid,
        isDetached: row.isDetached,
        inventoryVersion: row.inventoryVersion
      },
      reused: allocation.reused === true, startupTiming
    });
  }

  async #verify({ operationId, repositoryId, workspace, reused, baseContext = null, startupTiming = null }) {
    const repository = this.store.getGitRepository(repositoryId);
    const inventory = this.store.getGitWorktree(workspace.worktreeId);
    if (!repository || !inventory || inventory.repositoryId !== repositoryId
      || inventory.availability !== "available" || inventory.isMain === true
      || inventory.dedicated !== true || inventory.createdByStartupOperationId !== operationId) {
      throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Dedicated Worktree inventory is unavailable or belongs to another Repository.", true);
    }
    const canonicalWorktreePath = await measureStartup(startupTiming, "worktree.verify.canonical-path", () => canonical(workspace.path));
    const inventoryPath = await measureStartup(startupTiming, "worktree.verify.inventory-path", () => canonical(inventory.canonicalPath || inventory.path));
    if (canonicalWorktreePath !== inventoryPath) {
      throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree canonical path differs from Store inventory.", true);
    }
    const commonGitDirText = await measureStartup(startupTiming, "worktree.verify.git-common-dir", () => this.execGit(canonicalWorktreePath, ["rev-parse", "--git-common-dir"]));
    const commonGitDir = await canonical(resolve(canonicalWorktreePath, gitScalarOutput(commonGitDirText)));
    const registeredCommonGitDir = await canonical(repository.commonGitDirCanonicalPath);
    if (commonGitDir !== registeredCommonGitDir) {
      throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Worktree common Git directory differs from the registered Repository.", true);
    }
    const sourceCommitOid = gitScalarOutput(await measureStartup(startupTiming, "worktree.verify.git-head", () => this.execGit(canonicalWorktreePath, ["rev-parse", "HEAD"])));
    const sourceTreeOid = gitScalarOutput(await measureStartup(startupTiming, "worktree.verify.git-tree", () => this.execGit(canonicalWorktreePath, ["rev-parse", "HEAD^{tree}"])));
    if (!fullOid(sourceCommitOid) || !fullOid(sourceTreeOid)) {
      throw coded("START_SOURCE_IDENTITY_UNAVAILABLE", "Repository has no verifiable source commit/tree.", false);
    }
    const detached = inventory.isDetached === true || workspace.isDetached === true;
    if (baseContext && (sourceCommitOid !== baseContext.baseCommitOid || sourceTreeOid !== baseContext.baseTreeOid)) {
      throw coded("START_BASE_DIVERGED", "Prepared child Worktree differs from its frozen parent base.", false);
    }
    const branch = inventory.branchName ?? workspace.branchName ?? null;
    if (!detached && !branch) throw coded("START_WORKTREE_INVENTORY_MISMATCH", "Branch Worktree has no branch identity.", true);
    if (!workspace.localState) await measureStartup(startupTiming, "worktree.verify.local-state", () => ensureProjectLocalState(canonicalWorktreePath, { scope: "worktreeLocal" }));
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
      reused,
      ...(baseContext ? { baseContext } : {})
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
