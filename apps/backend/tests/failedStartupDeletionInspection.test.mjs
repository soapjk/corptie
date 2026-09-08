import assert from "node:assert/strict";
import test from "node:test";
import { inspectFailedStartupDeletion } from "../src/application/failedStartupDeletionInspection.mjs";

function fixture() {
  const allocation = { reused: false, createdByStartupOperationId: "start:one", worktreeId: "tree:one",
    repositoryId: "repo:one", canonicalWorktreePath: "/task/one", headIdentity: { branch: "task/one" } };
  const operation = { startup_operation_id: "start:one", state: "failed_manual_cleanup",
    repository_id: "repo:one", worktree_id: "tree:one", allocation_json: JSON.stringify(allocation) };
  const tree = { worktreeId: "tree:one", repositoryId: "repo:one", isMain: false,
    canonicalPath: "/task/one", branchName: "task/one", availability: "available",
    dirty: false, mergedIntoMain: true, sessions: [] };
  const session = { id: "session:orphan", taskId: "task:one", status: "complete" };
  const state = { operations: [operation], otherOwner: null, session, tree };
  const input = { task: { id: "task:one" }, session,
    store: {
      selectAll: () => state.operations, selectOne: () => state.otherOwner,
      getTaskWorkspaceContext: () => ({ repository: { id: "repo:one" } }),
      getGitWorktree: () => tree, listSessionsByTask: () => [session], getSession: () => state.bound
    },
    gitWorkspaces: { taskDeletionStatusForWorktree: async () => ({ worktrees: [tree] }) },
    isBusy: session => session.status === "running"
  };
  return { state, input, operation, allocation, tree, session };
}

test("orphan Session recovers deletion ownership from exact failed allocation, without enabling reclaim", async () => {
  const { input } = fixture();
  const result = await inspectFailedStartupDeletion(input);
  assert.equal(result.status, "available");
  assert.equal(result.blocker, null);
  assert.equal(result.canReclaim, false);
  assert.equal(result.ownershipSource, "failed-startup-allocation");
});

for (const [name, change, code] of [
  ["missing proof", f => { f.state.operations = []; }, "NO_WORKSPACE_ROUTE"],
  ["multiple worktrees", f => { f.state.operations.push({ ...f.operation, worktree_id: "other" }); }, "NO_WORKSPACE_ROUTE"],
  ["non-failed startup", f => { f.operation.state = "ready"; }, "NO_WORKSPACE_ROUTE"],
  ["malformed allocation", f => { f.operation.allocation_json = "{"; }, "NO_WORKSPACE_ROUTE"],
  ["reused directory", f => { f.allocation.reused = true; f.operation.allocation_json = JSON.stringify(f.allocation); }, "NO_WORKSPACE_ROUTE"],
  ["repository mismatch", f => { f.tree.repositoryId = "other"; }, "NO_WORKSPACE_ROUTE"],
  ["path mismatch", f => { f.tree.canonicalPath = "/shared"; }, "NO_WORKSPACE_ROUTE"],
  ["branch mismatch", f => { f.tree.branchName = "main"; }, "NO_WORKSPACE_ROUTE"],
  ["main worktree", f => { f.tree.isMain = true; }, "MAIN_WORKTREE"],
  ["another Task allocation", f => { f.state.otherOwner = { task_id: "other" }; }, "SHARED_WITH_ACTIVE_TASK"],
  ["foreign Session", f => { f.tree.sessions = [{ sessionId: "foreign" }]; f.state.bound = { taskId: "other" }; }, "SHARED_WITH_ACTIVE_TASK"],
  ["busy orphan", f => { f.session.status = "running"; }, "SESSION_BUSY"],
  ["unavailable directory", f => { f.tree.availability = "unavailable"; }, "WORKTREE_UNAVAILABLE"],
  ["uncommitted content", f => { f.tree.dirty = true; }, "UNCOMMITTED_CHANGES"],
  ["unmerged commits", f => { f.tree.mergedIntoMain = false; }, "NOT_MERGED_INTO_MAIN"]
]) {
  test(`failed-startup deletion preserves ${name} protection`, async () => {
    const f = fixture(); change(f);
    assert.equal((await inspectFailedStartupDeletion(f.input)).blocker, code);
  });
}
