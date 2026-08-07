import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectWorktreeCommitMessage } from "../src/runtime/projectCommitMessage.mjs";

test("an unowned dirty Worktree uses the requesting Session in an isolated generator", async () => {
  const calls = [];
  const message = await resolveProjectWorktreeCommitMessage({
    requestingSessionId: "codex:requester",
    worktree: {
      dirty: true,
      branchName: "feature/orphan",
      path: "/tmp/orphan-worktree",
      statusSummary: " M source.mjs",
      diffStat: "1 file changed",
      sessions: []
    },
    generateForSession: async () => assert.fail("no associated Session should be used"),
    generateForUnownedWorktree: async (...arguments_) => {
      calls.push(arguments_);
      return "fix orphaned worktree";
    }
  });

  assert.equal(message, "fix orphaned worktree");
  assert.deepEqual(calls, [[
    "codex:requester",
    "/tmp/orphan-worktree",
    {
      sourceBranch: "feature/orphan",
      sourcePath: "/tmp/orphan-worktree",
      statusSummary: " M source.mjs",
      diffStat: "1 file changed"
    }
  ]]);
});

test("an associated Session remains the preferred commit-message generator", async () => {
  let associatedSessionId = null;
  const message = await resolveProjectWorktreeCommitMessage({
    requestingSessionId: "codex:requester",
    worktree: {
      dirty: true,
      path: "/tmp/owned-worktree",
      sessions: [{ sessionId: "codex:owner" }]
    },
    generateForSession: async (sessionId) => {
      associatedSessionId = sessionId;
      return "owned change";
    },
    generateForUnownedWorktree: async () => assert.fail("fallback generator should not run")
  });

  assert.equal(message, "owned change");
  assert.equal(associatedSessionId, "codex:owner");
});
