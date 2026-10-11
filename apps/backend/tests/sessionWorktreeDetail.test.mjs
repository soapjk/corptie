import test from "node:test";
import assert from "node:assert/strict";
import { createProjectWorktreeStatusReader } from "../src/application/projectWorktreeStatusReader.mjs";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { rejectDevelopmentPreviewWrite } from "../src/application/backendHttpGuards.mjs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  const logical = { logicalSessionId: "logical", legacySessionId: "session", repositoryId: "repo", activeWorkspaceId: "tree", activeBinding: { boundCwd: "/tree" } };
  const session = { id: "session", status: "completed", external: { cwd: "/not-the-tree" } };
  const tree = { worktreeId: "tree", path: "/tree", branchName: "task", isMain: false, availability: "available", dirty: false, aheadOfMain: 3, behindMain: 2, changedFiles: [], conflictFiles: [] };
  const main = { ...tree, worktreeId: "main", isMain: true, branchName: "develop" };
  let reads = 0;
  const latest = { value: null };
  const service = createProjectWorktreeStatusReader({ store: { getLogicalSession: () => logical,
    getLogicalSessionByLegacySessionId: () => logical, getSession: () => session,
    listLogicalSessionsByWorkspaceId: () => [logical] },
    requireSessionReference: () => ({ sessionId: "session", logicalSessionId: "logical", metadata: { session } }),
    readLatestJob: () => latest.value,
    gitWorkspaces: { projectStatus: async id => { assert.equal(id, "logical"); reads++; return { mainWorktreeId: "main", worktrees: [tree, main] }; } } });
  return { service, logical, session, tree, main, latest, reads: () => reads };
}

test("Detail uses the persisted active Worktree and configured local main branch", async () => {
  const f = fixture();
  const result = await f.service.worktreeDetail("session");
  assert.equal(result.repositoryId, "repo");
  assert.equal(result.mainBranch, "develop");
  assert.equal(result.worktree.path, "/tree");
  assert.equal(result.worktree.aheadOfMain, 3);
  assert.equal(result.worktree.behindMain, 2);
  assert.equal(result.blockedReason, null);
  assert.equal(f.reads(), 1);
  f.tree.changedFiles = Array.from({ length: 200 }, (_, i) => `file-${i}.swift`);
  const bounded = await f.service.worktreeDetail("session");
  assert.equal(bounded.worktree.changedFileCount, 200);
  assert.equal(bounded.worktree.changedFiles.length, 20);
  f.latest.value = { id: "old", status: "canceled", plan: { items: [{ worktreeId: "tree" }] } };
  assert.equal((await f.service.worktreeDetail("session")).job, null);
  f.latest.value.status = "running";
  assert.equal((await f.service.worktreeDetail("session")).job.id, "old");
});

test("unbound Sessions never guess a tree from a provider cwd", async () => {
  const f = fixture(); f.logical.activeWorkspaceId = null;
  assert.equal((await f.service.worktreeDetail("session")).attached, false);
  assert.equal(f.reads(), 0);
});

test("unsafe states disable operations without conflating dirty files and commit counts", async () => {
  const f = fixture();
  for (const [row, field, value, reason] of [[f.tree, "dirty", true, "UNCOMMITTED_CHANGES"],
    [f.main, "dirty", true, "UNCOMMITTED_CHANGES"], [f.tree, "operationState", "rebase", "GIT_OPERATION_IN_PROGRESS"],
    [f.main, "isLocked", true, "WORKTREE_LOCKED"], [f.tree, "isDetached", true, "DETACHED_HEAD"],
    [f.tree, "availability", "missing", "WORKTREE_UNAVAILABLE"], [f.tree, "isMain", true, "MAIN_WORKTREE"]]) {
    const previous = row[field]; row[field] = value;
    assert.equal((await f.service.worktreeDetail("session")).blockedReason, reason);
    row[field] = previous;
  }
  for (const status of ["running", "blocked"]) {
    f.session.status = status;
    assert.equal((await f.service.worktreeDetail("session")).blockedReason, "SESSION_BUSY");
  }
});

test("bounded Detail enrichment reads local Git markers and retains changed/conflict files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-detail-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "rebase-merge"));
  const manager = new GitWorkspaceManager({ store: {} });
  manager.projectStatus = async () => ({ worktrees: [
    { path: "/tree", gitDirCanonicalPath: directory, availability: "available", statusSummary: "UU conflict.swift\n?? new.swift" },
    { path: "/main", availability: "available", statusSummary: "" }
  ] });
  const calls = [];
  manager.gitOutput = async (path, args) => { calls.push([path, args]); return "conflict.swift\n"; };
  const result = await manager.sessionDetailInspection("logical");
  assert.equal(result.worktrees[0].operationState, "rebase");
  assert.deepEqual(result.worktrees[0].changedFiles, ["conflict.swift", "new.swift"]);
  assert.deepEqual(result.worktrees[0].conflictFiles, ["conflict.swift"]);
  assert.deepEqual(calls, [["/tree", ["diff", "--name-only", "--diff-filter=U"]]]);
});

test("Development can read the new projection but cannot mutate Git", () => {
  const options = { response: {}, developmentPreview: true, sendJson: () => {},
    url: new URL("http://localhost/sessions/session/worktree-detail") };
  assert.equal(rejectDevelopmentPreviewWrite({ ...options, request: { method: "GET" } }), false);
  assert.equal(rejectDevelopmentPreviewWrite({ ...options, request: { method: "POST" } }), true);
  assert.equal(rejectDevelopmentPreviewWrite({ ...options, request: { method: "GET" },
    url: new URL("http://localhost/worktree-management/repositories/repo/integration-plans") }), true);
});
