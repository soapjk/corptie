import assert from "node:assert/strict";
import test from "node:test";
import { createProjectWorktreeGitOperations } from "../src/application/projectWorktreeGitOperations.mjs";

function fixture() {
  const calls = [];
  const source = {
    worktreeId: "tree", path: "/tree", dirty: true, availability: "available", isMain: false, sessions: []
  };
  const record = (name) => async (...args) => { calls.push([name, ...args]); return name; };
  const operations = createProjectWorktreeGitOperations({
    store: { getLogicalSessionByLegacySessionId: () => ({
      logicalSessionId: "logical", activeBinding: { boundCwd: "/current" }
    }) },
    gitWorkspaces: {
      projectStatus: async () => ({ worktrees: [source] }),
      commitWorktreeChanges: record("commit"),
      mergeWorktreeIntoMain: record("merge")
    },
    gitCommitProtection: { resolve: record("protect"), inspect: record("inspect") },
    projectToolsets: { inspect: async () => ({ configured: true }) },
    generateSessionCommitMessage: record("ownedMessage"),
    generateUnownedWorktreeCommitMessage: record("unownedMessage"),
    rebuildAndRestartProjectService: record("restart"),
    projectWorktreeStatus: async () => ({ current: true })
  });
  return { calls, source, operations };
}

test("commit protection is resolved before committing the selected worktree", async () => {
  const f = fixture();
  const result = await f.operations.commitProjectWorktree("session", "tree", {
    commitMessage: "Requested message", privateFilesDecision: "exclude", neverRemindPrivateFiles: true
  });
  assert.deepEqual(f.calls, [
    ["protect", "/tree", { decision: "exclude", neverRemind: true }],
    ["commit", { logicalSessionId: "logical", sourceWorktreeId: "tree", commitMessage: "Requested message" }]
  ]);
  assert.deepEqual(result, { commit: "commit", current: true });
});

test("clean worktrees cannot be committed, prepared or given a generated commit message", async () => {
  const f = fixture();
  f.source.dirty = false;
  for (const operation of [
    f.operations.commitProjectWorktree, f.operations.prepareProjectWorktreeCommit,
    f.operations.generateProjectWorktreeCommitMessage
  ]) {
    await assert.rejects(operation("session", "tree"), /no uncommitted changes/);
  }
  assert.deepEqual(f.calls, []);
});

test("merge preserves source synchronization and the requested restart directory", async () => {
  const f = fixture();
  await f.operations.mergeProjectWorktree("session", "tree", {
    commitMessage: "Merge task", restartService: true
  });
  assert.deepEqual(f.calls.map((call) => call[0]), ["protect", "merge", "restart"]);
  assert.equal(f.calls[1][1].synchronizeSource, true);
  assert.deepEqual(f.calls[2], ["restart", "/current"]);
});

test("explicit worktree restart uses the selected path as execution root", async () => {
  const f = fixture();
  assert.deepEqual(await f.operations.restartProjectWorktree("session", "tree"), {
    restart: "restart", current: true
  });
  assert.deepEqual(f.calls, [["restart", "/tree", "/tree"]]);
});
