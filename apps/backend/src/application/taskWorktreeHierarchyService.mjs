import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { taskHierarchyError as error } from "../store/repositories/taskHierarchyRepository.mjs";

const execFile = promisify(execFileCallback);
async function runGit(path, args) {
  return (await execFile("git", ["-C", path, ...args], { encoding:"utf8", timeout:15000, maxBuffer:1024*1024 })).stdout.trim();
}

// Project capability; never depends on an Agent Provider or its configuration.
export class TaskWorktreeHierarchyService {
  constructor({ store, execGit = runGit }) { this.store = store; this.git = execGit; }

  resolveTaskDelivery(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw error("TASK_PARENT_UNAVAILABLE");
    let binding = this.store.getTaskDeliveryBinding(taskId);
    if (!binding) {
      // Legacy adoption requires exactly one proven ready allocation. Never
      // infer ownership from a Session's latest cwd or Git association order.
      const proofs = this.store.selectAll(`SELECT o.startup_operation_id,o.repository_id,o.worktree_id
        FROM work_session_startup_operations o JOIN work_session_startup_receipts r
          ON r.startup_operation_id=o.startup_operation_id
        WHERE o.task_id=? AND o.state='ready'`, [taskId]);
      if (proofs.length !== 1) throw error("PARENT_WORKTREE_REQUIRED");
      const proof = proofs[0];
      binding = this.store.runInTransaction(() => this.store.bindTaskDeliveryWorktree({taskId,
        repositoryId:proof.repository_id,worktreeId:proof.worktree_id,startupOperationId:proof.startup_operation_id}));
    }
    const inventory = this.store.getGitWorktree(binding.worktree_id);
    const proof = this.store.selectOne(`SELECT o.task_id,o.repository_id,o.worktree_id FROM work_session_startup_operations o
      JOIN work_session_startup_receipts r ON r.startup_operation_id=o.startup_operation_id
      WHERE o.startup_operation_id=? AND o.state='ready'`, [binding.startup_operation_id]);
    if (!inventory || inventory.availability !== "available" || inventory.isMain || inventory.isDetached
      || inventory.repositoryId !== binding.repository_id || !proof || proof.task_id !== taskId
      || proof.worktree_id !== inventory.worktreeId || proof.repository_id !== binding.repository_id
      || this.store.getTaskWorkspaceContext(task)?.repository?.id !== binding.repository_id) {
      throw error("PARENT_WORKTREE_REQUIRED");
    }
    return { task, binding, inventory };
  }

  async validateCreate(taskInput, constraints = {}) {
    if (!taskInput?.parentTaskId) return;
    this.store.assertParentForCreate({ ...taskInput, ...constraints });
    const context = this.store.getTaskWorkspaceContext(taskInput.parentTaskId);
    if (context?.repository) {
      const { inventory } = this.resolveTaskDelivery(taskInput.parentTaskId);
      await this.assertClean(inventory);
    }
  }

  async assertClean(inventory) {
    const path = inventory.canonicalPath || inventory.path;
    const repository = this.store.getGitRepository(inventory.repositoryId);
    const common = await this.git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!repository || await realpath(common) !== await realpath(repository.commonGitDirCanonicalPath)) {
      throw error("TASK_DELIVERY_BINDING_CHANGED");
    }
    const status = await this.git(path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    if (status) throw error("PARENT_WORKTREE_DIRTY", "Commit or handle parent Worktree changes before creating a child.");
    for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
      const result = await this.git(path, ["rev-parse", "--verify", "--quiet", ref]).catch(cause => {
        if (cause.code === 1 || cause.code === 128) return "";
        throw cause;
      });
      if (result) throw error("TASK_HIERARCHY_BUSY");
    }
  }

  async freezeBaseForStartup({ startupOperationId, taskId, repositoryId }) {
    const task = this.store.getTask(taskId);
    if (!task?.parent_task_id) return null;
    const operation = this.store.selectOne("SELECT * FROM work_session_startup_operations WHERE startup_operation_id=?", [startupOperationId]);
    if (!operation || operation.task_id !== taskId || operation.repository_id !== repositoryId) throw error("START_REFERENCE_INVALID");
    if (operation.worktree_base_context_json) {
      const frozen = JSON.parse(operation.worktree_base_context_json);
      this.assertBaseBinding(task, frozen);
      return frozen;
    }
    const { task:parent, binding, inventory } = this.resolveTaskDelivery(task.parent_task_id);
    if (parent.parent_task_id || parent.work_id !== task.work_id || binding.repository_id !== repositoryId) throw error("TASK_PARENT_INVALID");
    if (parent.archived || parent.lifecycle_state === "done" || parent.deletion_status) throw error("TASK_PARENT_UNAVAILABLE");
    await this.assertClean(inventory);
    const path = inventory.canonicalPath || inventory.path;
    const baseCommitOid = await this.git(path, ["rev-parse", "HEAD"]);
    const baseTreeOid = await this.git(path, ["rev-parse", `${baseCommitOid}^{tree}`]);
    if (!/^[a-f0-9]{40,64}$/i.test(baseCommitOid) || !/^[a-f0-9]{40,64}$/i.test(baseTreeOid)) throw error("START_SOURCE_IDENTITY_UNAVAILABLE");
    await this.assertClean(inventory);
    if (await this.git(path, ["rev-parse", "HEAD"]) !== baseCommitOid) throw error("TASK_HIERARCHY_CHANGED");
    const base = {version:1,kind:"parent",rootTaskId:parent.id,parentTaskId:parent.id,
      parentWorktreeId:binding.worktree_id,parentBindingRevision:binding.binding_revision,
      hierarchyRevision:parent.hierarchy_revision,baseCommitOid,baseTreeOid};
    return this.store.runInTransaction(() => {
      this.assertBaseBinding(this.store.getTask(taskId), base);
      this.store.db.run(`UPDATE work_session_startup_operations SET worktree_base_context_json=?
        WHERE startup_operation_id=? AND worktree_base_context_json IS NULL`, [JSON.stringify(base),startupOperationId]);
      this.store.scheduleSave();
      const persisted = JSON.parse(this.store.selectOne("SELECT worktree_base_context_json FROM work_session_startup_operations WHERE startup_operation_id=?", [startupOperationId]).worktree_base_context_json);
      this.assertBaseBinding(this.store.getTask(taskId), persisted);
      return persisted;
    });
  }

  assertBaseBinding(task, base) {
    const parent = this.store.getTask(base.parentTaskId);
    const binding = this.store.getTaskDeliveryBinding(base.parentTaskId);
    if (!task || task.parent_task_id !== base.parentTaskId || !parent || parent.parent_task_id
      || parent.work_id !== task.work_id || !binding || binding.worktree_id !== base.parentWorktreeId
      || binding.binding_revision !== base.parentBindingRevision) throw error("TASK_DELIVERY_BINDING_CHANGED");
    // Sibling creation and subsequent parent commits intentionally do not
    // invalidate the already captured commit. Only this relationship/binding does.
  }
}
