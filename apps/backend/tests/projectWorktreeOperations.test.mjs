import assert from "node:assert/strict";
import test from "node:test";
import { createProjectWorktreeOperations } from "../src/application/projectWorktreeOperations.mjs";

function fixture() {
  const calls = [];
  const session = { id: "session:one", status: "idle" };
  const source = {
    worktreeId: "tree:one", isMain: false, availability: "available",
    sessions: [{ sessionId: session.id, logicalSessionId: "logical:one" }]
  };
  const record = (name) => async (input) => { calls.push([name, input]); return { ok: true }; };
  const operations = createProjectWorktreeOperations({
    store: {
      getLogicalSessionByLegacySessionId: () => ({
        logicalSessionId: "logical:one", activeBinding: { boundCwd: "/worktree" }
      }),
      getSession: () => session,
      deleteLogicalSessionByLegacySessionId: (id) => calls.push(["deleteRoute", id]),
      deleteSession: (id) => calls.push(["deleteSession", id])
    },
    gitWorkspaces: {
      projectStatus: async () => ({ repositoryId: "repository:one", mainPath: "/main", worktrees: [source] }),
      mergeWorktreeIntoMain: record("merge"),
      synchronizeWorktreeWithMain: record("synchronize"),
      removeMergedWorktree: record("remove")
    },
    projectToolsets: { inspect: async () => ({ configured: true }) },
    collaborationCore: { detachSession: (id) => calls.push(["detach", id]) },
    resolveProjectCommitProtection: record("protect"),
    commitMessageForProjectWorktree: async () => "Commit task",
    rebuildAndRestartProjectService: record("restart"),
    emitEvent: (type, payload, options) => calls.push(["event", type, payload, options])
  });
  return { calls, session, operations };
}

test("rejects empty or conflicting operation selections before mutation", async () => {
  const f = fixture();
  await assert.rejects(f.operations.operateProjectWorktree("session:one", "tree:one", {}), /Select at least one/);
  await assert.rejects(f.operations.operateProjectWorktree("session:one", "tree:one", {
    deleteWorktree: true, mergeIntoMain: true
  }), /cannot be combined/);
  assert.deepEqual(f.calls, []);
});

test("worktree completion requires session deletion confirmation and refuses busy sessions", async () => {
  const f = fixture();
  await assert.rejects(f.operations.completeProjectWorktree("session:one", "tree:one"), /requires confirmation/);
  f.session.status = "running";
  await assert.rejects(f.operations.completeProjectWorktree("session:one", "tree:one", {
    deleteSessions: true
  }), { code: "SESSION_BUSY" });
  assert.deepEqual(f.calls, []);
});

test("completion preserves protection, merge, cleanup, session retirement and restart order", async () => {
  const f = fixture();
  const result = await f.operations.completeProjectWorktree("session:one", "tree:one", {
    deleteSessions: true
  });
  assert.deepEqual(f.calls.map((call) => call[0]), [
    "protect", "merge", "remove", "detach", "deleteRoute", "deleteSession", "event", "restart", "event"
  ]);
  assert.deepEqual(result.deletedSessionIds, ["session:one"]);
  assert.deepEqual(f.calls[2][1].ignoreLogicalSessionIds, ["logical:one"]);
  assert.deepEqual(f.calls[6][3], { detachedSession: true });
  assert.equal(f.calls[8][1], "ProjectWorktreeCompleted");
});

test("synchronizing alone does not merge, delete sessions, remove worktrees or restart", async () => {
  const f = fixture();
  const result = await f.operations.operateProjectWorktree("session:one", "tree:one", {
    synchronizeWithMain: true
  });
  assert.deepEqual(f.calls.map((call) => call[0]), ["synchronize", "event"]);
  assert.deepEqual(result.deletedSessionIds, []);
  assert.equal(result.cleanup, null);
  assert.equal(result.restart, null);
  assert.equal(result.merge, null);
});
