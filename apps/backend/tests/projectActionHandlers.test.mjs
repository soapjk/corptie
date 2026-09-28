import assert from "node:assert/strict";
import test from "node:test";
import { createProjectActionHandlers } from "../src/application/projectActionHandlers.mjs";

function fixture() {
  const calls = [];
  const workspace = { worktreeId: "tree", path: "/tree", availability: "available", dirty: true };
  const record = (name) => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const handlers = createProjectActionHandlers({
    store: {
      getGitRepository: () => ({ id: "project" }),
      listGitWorktrees: () => [{ isMain: true, availability: "available", path: "/main", canonicalPath: "/canonical", worktreeId: "main" }]
    },
    gitWorkspaces: {
      projectStatusForPath: async (...args) => { calls.push(["inspect", ...args]); return { worktrees: [workspace] }; },
      removeWorktreeForProject: record("remove"),
      commitWorktreeChangesForProject: record("commit"),
      mergeWorktreeIntoMainForProject: record("merge")
    },
    projectToolsets: { inspect: async () => ({ configured: true }), run: record("run"), selectProfile: record("profile") },
    gitCommitProtection: { inspect: record("protectionInspect") },
    gitHubPushes: { pushBranch: record("push") },
    rebuildAndRestartProjectService: record("restart"),
    generateUnownedWorktreeCommitMessage: async () => "message",
    resolveProjectCommitProtection: record("protection")
  });
  return { calls, handlers, workspace, project: { id: "project", mainPath: "/main" } };
}

test("project context resolves the available main worktree canonical path", () => {
  const f = fixture();
  assert.deepEqual(f.handlers.resolveProjectContext("project"), {
    id: "project", mainPath: "/canonical", mainWorkspaceId: "main"
  });
});

test("project-level initialization cannot bypass authenticated Work Session setup", async () => {
  const f = fixture();
  for (const action of ["initialize", "update"]) {
    await assert.rejects(f.handlers.performProjectDevelopmentServiceAction(f.project, action), {
      code: "TOOLSET_PERMISSION_DENIED", statusCode: 403
    });
  }
  assert.deepEqual(f.calls, []);
});

test("workspace mutations require fresh management inspection and commit protection", async () => {
  const f = fixture();
  await f.handlers.performProjectWorkspaceAction(f.project, "tree", "commit", { commitMessage: "commit" });
  assert.deepEqual(f.calls.map(([name]) => name), ["inspect", "protection", "commit"]);
  assert.equal(f.calls[0][3].forceFresh, true);
  assert.equal(f.calls[0][3].inspectionLevel, "management");
  assert.equal(f.calls[2][1].sourceWorktreeId, "tree");
});

test("deletion forwards explicit irreversible-operation acknowledgements", async () => {
  const f = fixture();
  await f.handlers.performProjectWorkspaceAction(f.project, "tree", "delete", {
    deleteBranch: false, forceDeleteUnmerged: true, acknowledgeIrrecoverable: true, confirmedBranchName: "task"
  });
  assert.deepEqual(f.calls[1], ["remove", {
    repositoryId: "project", workingDirectory: "/main", sourceWorktreeId: "tree",
    deleteBranch: false, forceDeleteUnmerged: true, acknowledgeIrrecoverable: true, confirmedBranchName: "task"
  }]);
});

test("unavailable workspaces are rejected before an operation is dispatched", async () => {
  const f = fixture();
  f.workspace.availability = "missing";
  await assert.rejects(f.handlers.performProjectWorkspaceAction(f.project, "tree", "commit"), { code: "WORKSPACE_NOT_FOUND" });
  assert.deepEqual(f.calls.map(([name]) => name), ["inspect"]);
});
