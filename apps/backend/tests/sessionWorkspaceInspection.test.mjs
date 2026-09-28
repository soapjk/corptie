import assert from "node:assert/strict";
import test from "node:test";
import { createSessionWorkspaceInspection } from "../src/application/sessionWorkspaceInspection.mjs";

function fixture() {
  const logical = { logicalSessionId: "logical", repositoryId: "repository", activeWorkspaceId: "old",
    activeBinding: { boundCwd: "/old" } };
  const worktrees = [
    { worktreeId: "old", branchName: "task", isMain: false, availability: "missing" },
    { worktreeId: "main", branchName: "main", isMain: true, availability: "available", path: "/main" }
  ];
  let error = null;
  const inspection = createSessionWorkspaceInspection({
    store: {
      getSession: () => ({ id: "session" }),
      getLogicalSessionByLegacySessionId: () => logical,
      getGitWorktree: (id) => worktrees.find((tree) => tree.worktreeId === id),
      listGitWorktrees: () => worktrees,
      upsertGitWorkspaceSnapshot: () => { throw new Error("must not persist failed refresh"); }
    },
    gitWorkspaces: { sessionDeletionPlan: async () => ({ requiresWorktreeMerge: true }) },
    assertWorkspaceRouteUsable: async () => { if (error) throw error; },
    createGitWorkspaceSnapshot: async () => { throw new Error("offline"); }
  });
  return { inspection, logical, fail: (code) => { error = Object.assign(new Error("unavailable"), { code }); } };
}

test("valid routes need no workspace recovery", async () => {
  assert.deepEqual(await fixture().inspection.sessionWorkspaceRecoveryStatus("session"), {
    orphaned: false, worktrees: []
  });
});

test("failed inventory refresh retains known recovery choices", async () => {
  const f = fixture();
  f.fail("WORKSPACE_UNAVAILABLE");
  const result = await f.inspection.sessionWorkspaceRecoveryStatus("session");
  assert.equal(result.orphaned, true);
  assert.equal(result.canRebuild, true);
  assert.equal(result.originalBranchName, "task");
  assert.deepEqual(result.worktrees.map((tree) => tree.worktreeId), ["main"]);
});

test("unavailable workspace deletion returns its identity instead of proposing a merge", async () => {
  const f = fixture();
  f.fail("WORKSPACE_IDENTITY_CHANGED");
  const plan = await f.inspection.sessionDeletionPlan("codex:session");
  assert.equal(plan.requiresWorktreeMerge, false);
  assert.equal(plan.workspaceUnavailable, true);
  assert.equal(plan.sourcePath, "/old");
  assert.equal(plan.sourceBranch, "task");
});

test("unexpected route errors propagate and missing routes report not found", async () => {
  const f = fixture();
  f.fail("DATABASE_ERROR");
  await assert.rejects(f.inspection.sessionWorkspaceRecoveryStatus("session"), { code: "DATABASE_ERROR" });
  f.logical.activeBinding = null;
  await assert.rejects(f.inspection.sessionWorkspaceRecoveryStatus("session"), { statusCode: 404 });
});
