import assert from "node:assert/strict";
import test from "node:test";
import { createTaskWorktreeOperations } from "../src/application/taskWorktreeOperations.mjs";

function fixture() {
  const calls = [];
  const task = { id: "task:one", current_session_id: "session:one", lifecycle_state: "completed" };
  const session = { id: "session:one", taskId: task.id, status: "idle" };
  const logical = { logicalSessionId: "logical:one", activeBinding: {}, activeWorkspaceId: "tree:one" };
  const worktree = {
    worktreeId: "tree:one", availability: "available", isMain: false,
    dirty: false, mergedIntoMain: true, pendingIntegration: false,
    sessions: [{ sessionId: session.id, logicalSessionId: logical.logicalSessionId }]
  };
  const store = {
    getTask: () => task,
    listSessionsByTask: () => [session],
    getSession: () => session,
    getLogicalSessionByLegacySessionId: () => logical,
    getLogicalSession: () => logical,
    retireLogicalSessionWorkspace: (...args) => {
      calls.push(["retire", ...args]);
      logical.activeWorkspaceId = null;
    }
  };
  const gitWorkspaces = {
    taskDeletionStatus: async () => ({ repositoryId: "repository:one", worktrees: [worktree] }),
    removeMergedWorktree: async (input) => { calls.push(["removeMerged", input]); return { removed: true }; },
    removeWorktreeForProject: async (input) => { calls.push(["remove", input]); return { removed: true }; }
  };
  const operations = createTaskWorktreeOperations({
    store, gitWorkspaces,
    projectApplicationService: { requireProject: async () => ({ mainPath: "/project" }) },
    emitEvent: (...args) => calls.push(["event", ...args])
  });
  return { operations, calls, task, session, logical, worktree, store };
}

test("inspection reports an absent task without attempting cleanup", async () => {
  const f = fixture();
  f.store.getTask = () => null;
  await assert.rejects(f.operations.inspectTaskWorktree("missing"), {
    code: "TASK_NOT_FOUND", statusCode: 404
  });
  assert.deepEqual(f.calls, []);
});

test("reclamation refuses incomplete, main, dirty, unmerged and pending-integration worktrees", async () => {
  for (const [mutate, blocker] of [
    [(f) => { f.task.lifecycle_state = "active"; }, "TASK_NOT_COMPLETED"],
    [(f) => { f.worktree.isMain = true; }, "MAIN_WORKTREE"],
    [(f) => { f.worktree.dirty = true; }, "UNCOMMITTED_CHANGES"],
    [(f) => { f.worktree.mergedIntoMain = false; }, "NOT_MERGED_INTO_MAIN"],
    [(f) => { f.worktree.pendingIntegration = true; }, "INTEGRATION_PENDING"]
  ]) {
    const f = fixture();
    mutate(f);
    const inspection = await f.operations.inspectTaskWorktree(f.task.id);
    assert.equal(inspection.blocker, blocker);
    assert.equal(inspection.canReclaim, false);
    await assert.rejects(f.operations.reclaimTaskWorktree(f.task.id), { code: blocker, statusCode: 409 });
    assert.deepEqual(f.calls, []);
  }
});

test("reclamation removes before retiring routes and emits the completed operation", async () => {
  const f = fixture();
  const result = await f.operations.reclaimTaskWorktree(f.task.id);
  assert.deepEqual(f.calls.map((call) => call[0]), ["removeMerged", "retire", "event"]);
  assert.deepEqual(f.calls[0][1], {
    logicalSessionId: "logical:one", sourceWorktreeId: "tree:one",
    ignoreLogicalSessionIds: ["logical:one"], deleteBranch: true
  });
  assert.equal(f.calls[2][1], "TaskWorktreeReclaimed");
  assert.equal(result.canReclaim, false);
  assert.deepEqual(result.cleanup, { removed: true });
});

test("deletion forwards explicit force confirmation and only retires matching routes", async () => {
  const f = fixture();
  const inspection = await f.operations.inspectTaskWorktree(f.task.id);
  f.logical.activeWorkspaceId = "tree:replacement";
  await f.operations.removeTaskDeletionWorktree({
    inspection, force: true, confirmedBranchName: "task/one"
  });
  assert.deepEqual(f.calls, [["remove", {
    repositoryId: "repository:one", workingDirectory: "/project",
    sourceWorktreeId: "tree:one", ignoreLogicalSessionIds: ["logical:one"],
    deleteBranch: true, forceDeleteUnmerged: true,
    acknowledgeIrrecoverable: true, confirmedBranchName: "task/one"
  }]]);
});
