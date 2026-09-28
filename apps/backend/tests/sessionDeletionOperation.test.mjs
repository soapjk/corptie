import assert from "node:assert/strict";
import test from "node:test";
import { deleteSessionWithOptionalMerge } from "../src/application/sessionDeletionOperation.mjs";
import { handleSessionMutationHttpRequest } from "../src/application/sessionMutationHttpApi.mjs";

function fixture() {
  const calls = [];
  const dependencies = {
    sessionApplicationService: {
      referenceFor: async () => ({ sessionId: "stored", providerId: "fixture" }),
      deleteSession: async (...args) => { calls.push(["delete", ...args]); return { deleted: true }; }
    },
    sessionDeletionPlan: async () => { calls.push(["plan"]); return { requiresWorktreeMerge: true }; },
    mergeSessionWorktreeBeforeDeletion: async () => { calls.push(["merge"]); return { sourceWorktreeId: "tree" }; },
    store: {
      getLogicalSessionByLegacySessionId: () => ({ logicalSessionId: "logical" }),
      listLogicalSessionsByWorkspaceId: () => [{ logicalSessionId: "logical" }]
    },
    gitWorkspaces: { removeMergedWorktree: async (input) => { calls.push(["cleanup", input]); return { removed: true }; } },
    supportsMergeBeforeDeletion: () => true
  };
  return { calls, dependencies };
}

test("plain deletion never invokes merge or cleanup", async () => {
  const f = fixture();
  assert.deepEqual(await deleteSessionWithOptionalMerge("public", {}, f.dependencies), { deleted: true, merge: null });
  assert.deepEqual(f.calls, [["delete", "public", { source: "http" }]]);
});

test("merge and cleanup finish before deletion and shared worktrees are retained", async () => {
  const f = fixture();
  const result = await deleteSessionWithOptionalMerge("public", { mergeWorktree: true }, f.dependencies);
  assert.deepEqual(f.calls.map(([name]) => name), ["plan", "merge", "cleanup", "delete"]);
  assert.deepEqual(f.calls[2][1], { logicalSessionId: "logical", sourceWorktreeId: "tree", ignoreLogicalSessionIds: ["logical"], deleteBranch: true });
  assert.equal(result.merge.cleanup.removed, true);
  f.calls.length = 0;
  f.dependencies.store.listLogicalSessionsByWorkspaceId = () => [{ logicalSessionId: "logical" }, { logicalSessionId: "other" }];
  const shared = await deleteSessionWithOptionalMerge("public", { mergeWorktree: true }, f.dependencies);
  assert.deepEqual(shared.merge.cleanup, { removed: false, reason: "sharedWorktree", remainingSessionCount: 1 });
  assert.deepEqual(f.calls.map(([name]) => name), ["plan", "merge", "delete"]);
});

test("capability, plan, merge and cleanup failures all prevent Session deletion", async () => {
  for (const stage of ["capability", "plan", "merge", "cleanup"]) {
    const f = fixture();
    if (stage === "capability") f.dependencies.supportsMergeBeforeDeletion = () => false;
    if (stage === "plan") f.dependencies.sessionDeletionPlan = async () => ({ requiresWorktreeMerge: false });
    if (stage === "merge") f.dependencies.mergeSessionWorktreeBeforeDeletion = async () => { throw new Error("merge failed"); };
    if (stage === "cleanup") f.dependencies.gitWorkspaces.removeMergedWorktree = async () => { throw new Error("cleanup failed"); };
    await assert.rejects(deleteSessionWithOptionalMerge("public", { mergeWorktree: true }, f.dependencies));
    assert.ok(!f.calls.some(([name]) => name === "delete"), stage);
  }
});

test("mutation HTTP dispatch preserves title reservation release and delete options", async () => {
  const calls = [];
  let failRename = false;
  const dependencies = {
    sessionDeletionPlan: async () => ({ requiresWorktreeMerge: false }),
    sessionApplicationService: { renameSession: async (...args) => { calls.push(["rename", ...args]); if (failRename) throw new Error("failed"); return { id: "session" }; } },
    reserveSessionTitle: (...args) => { calls.push(["reserve", ...args]); return () => calls.push(["release"]); },
    deleteSession: async (...args) => { calls.push(["delete", ...args]); return { deleted: true, merge: null }; },
    emitEvent: (...args) => calls.push(["event", ...args]),
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error) => error.statusCode ?? 400,
    unifiedErrorStatus: () => 400,
    sessionTitleErrorPayload: (error) => ({ error: error.message })
  };
  function dispatch(path, method, body = {}) {
    return new Promise((resolve) => {
      assert.equal(handleSessionMutationHttpRequest({ ...dependencies, request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") }), true);
    });
  }
  assert.equal((await dispatch("/sessions/public%2Fid", "PATCH", { title: " title " })).status, 200);
  assert.deepEqual(calls.map(([name]) => name), ["reserve", "rename", "event", "release"]);
  assert.deepEqual(calls[1], ["rename", "public/id", "title", { source: "http" }]);
  calls.length = 0;
  failRename = true;
  assert.equal((await dispatch("/sessions/public", "PATCH", { title: "title" })).status, 400);
  assert.deepEqual(calls.map(([name]) => name), ["reserve", "rename", "release"]);
  calls.length = 0;
  assert.equal((await dispatch("/sessions/public", "PATCH", { avatarPath: "image", title: "title" })).body.code, "SESSION_AVATAR_UNSUPPORTED");
  assert.deepEqual(calls, []);
  assert.equal((await dispatch("/sessions/public?mergeWorktree=true", "DELETE")).status, 200);
  assert.deepEqual(calls, [["delete", "public", { mergeWorktree: true }]]);
  assert.equal((await dispatch("/sessions/public/deletion-plan", "GET")).status, 200);
});
