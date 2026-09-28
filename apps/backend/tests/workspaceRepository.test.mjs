import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("workspace snapshot failure rolls back identity, inventory and revision; retry preserves no-op writes", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-workspace-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const snapshot = {
      repository: { id: "repository:test", commonGitDirCanonicalPath: "/repo/.git" },
      inventoryVersion: "inventory-v1", observedAt: "2026-07-28T00:00:00.000Z",
      worktrees: [{ worktreeId: "worktree:main", path: "/repo", canonicalPath: "/repo",
        gitDirCanonicalPath: "/repo/.git", isMain: true, availability: "available",
        headOid: "abc123", branchRef: "refs/heads/main", branchName: "main" }]
    };
    const revision = store.stateRevision();
    const originalRun = store.db.run;
    const failure = new Error("injected inventory write failure");
    store.db.run = function (sql, ...args) {
      if (/INSERT INTO git_worktrees/.test(sql)) throw failure;
      return originalRun.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.upsertGitWorkspaceSnapshot(snapshot), error => error === failure);
    } finally {
      store.db.run = originalRun;
    }
    assert.deepEqual(store.listWorkspaces(), []);
    assert.deepEqual(store.listGitRepositories(), []);
    assert.deepEqual(store.listAllGitWorktrees(), []);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    const result = store.upsertGitWorkspaceSnapshot(snapshot);
    const committedRevision = store.stateRevision();
    assert.ok(committedRevision > revision);
    assert.equal(notifications, 1);
    assert.equal(store.resolveWorkspacePath("repository:test"), "/repo");
    const worktree = store.getGitWorktree("worktree:main");
    assert.deepEqual(store.upsertGitWorkspaceSnapshot({ ...snapshot, observedAt: "2026-07-29T00:00:00.000Z" }), result);
    assert.deepEqual(store.getGitWorktree("worktree:main"), worktree);
    assert.equal(store.stateRevision(), committedRevision);
    assert.equal(notifications, 1);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
