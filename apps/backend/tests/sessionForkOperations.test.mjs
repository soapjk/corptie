import test from "node:test";
import assert from "node:assert/strict";
import { createSessionForkOperations } from "../src/application/sessionForkOperations.mjs";

test("fork workspace refuses a stale source binding before creating files", async () => {
  const { prepareConversationForkWorkspace } = createSessionForkOperations({
    store: { getLogicalSessionByLegacySessionId: () => ({
      repositoryId: "repository:one", activeBinding: { bindingId: "current", boundCwd: "/source" }
    }) },
    createForkWorktree: () => assert.fail("stale binding cannot create a worktree")
  });
  await assert.rejects(prepareConversationForkWorkspace({
    session: { id: "session" }, reference: { bindingId: "old" }
  }, "task"), { code: "FORK_WORKSPACE_UNAVAILABLE" });
});

test("fork worktree is inventoried and gated before its identity is returned", async () => {
  const calls = [];
  const { prepareConversationForkWorkspace } = createSessionForkOperations({
    store: {
      layout: { worktreesDirectory: "/worktrees" }, dbPath: "/state/database",
      getLogicalSessionByLegacySessionId: () => ({
        repositoryId: "repository:one", activeBinding: { bindingId: "binding", boundCwd: "/source" }
      }),
      upsertGitWorkspaceSnapshot: () => calls.push("inventory")
    },
    createForkWorktree: async ({ sourcePath, targetPath }) => {
      assert.equal(sourcePath, "/source");
      calls.push("create");
      return { path: targetPath };
    },
    createGitWorkspaceSnapshot: async (path) => ({
      repository: { id: "repository:one" }, worktrees: [{ path, worktreeId: "worktree" }]
    }),
    ensureArtifactCommitHook: async (_path, options) => {
      assert.equal(options.dbPath, "/state/database");
      calls.push("gate");
    }
  });
  const result = await prepareConversationForkWorkspace({
    session: { id: "session" }, reference: { bindingId: "binding" }
  }, "task");
  assert.deepEqual(calls, ["create", "inventory", "gate"]);
  assert.equal(result.worktreeId, "worktree");
  assert.equal(result.reused, false);
});

test("fork workspace rolls back when post-allocation preparation fails", async () => {
  const calls = [];
  const { prepareConversationForkWorkspace } = createSessionForkOperations({
    store: {
      layout: { worktreesDirectory: "/worktrees" }, dbPath: "/state/database",
      getLogicalSessionByLegacySessionId: () => ({
        repositoryId: "repository:one", activeBinding: { bindingId: "binding", boundCwd: "/source" }
      }),
      upsertGitWorkspaceSnapshot: () => calls.push("inventory")
    },
    createForkWorktree: async () => ({
      path: "/worktrees/one/fork-target",
      rollback: async () => calls.push("rollback")
    }),
    createGitWorkspaceSnapshot: async path => ({
      repository: { id: "repository:one" }, worktrees: [{ path, worktreeId: "worktree" }]
    }),
    ensureArtifactCommitHook: async () => { throw new Error("gate failed"); }
  });

  await assert.rejects(prepareConversationForkWorkspace({
    session: { id: "session" }, reference: { bindingId: "binding" }
  }, "task"), /gate failed/);
  assert.deepEqual(calls, ["inventory", "rollback"]);
});

test("chat fork removes its allocated worktree when session creation fails", async () => {
  const calls = [];
  const { sessionForkService } = createSessionForkOperations({
    store: {
      layout: { worktreesDirectory: "/worktrees" }, dbPath: "/state/database",
      getLogicalSessionByLegacySessionId: () => ({
        repositoryId: "repository:one", activeBinding: { bindingId: "binding", boundCwd: "/source" }
      }),
      upsertGitWorkspaceSnapshot: () => calls.push("inventory")
    },
    createForkWorktree: async () => ({
      path: "/worktrees/one/fork-target",
      rollback: async () => calls.push("rollback")
    }),
    createGitWorkspaceSnapshot: async path => ({
      repository: { id: "repository:one" }, worktrees: [{ path, worktreeId: "worktree" }]
    }),
    ensureArtifactCommitHook: async () => calls.push("gate"),
    createSessionThroughApplication: async () => {
      calls.push("create-session");
      throw Object.assign(new Error("provider failed"), { code: "PROVIDER_FAILED" });
    }
  });

  await assert.rejects(sessionForkService.createChat({
    source: {
      session: { id: "session", agentId: "agent", external: {} },
      reference: { providerId: "provider", bindingId: "binding" }
    },
    input: { requestId: "request-123", title: "Fork" }
  }), { code: "PROVIDER_FAILED" });
  assert.deepEqual(calls, ["inventory", "gate", "create-session", "rollback"]);
});
