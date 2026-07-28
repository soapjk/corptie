import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkspaceRouteUsable } from "../src/runtime/workspaceRouteGuard.mjs";

const worktree = {
  worktreeId: "worktree:one",
  availability: "available"
};

function route(overrides = {}) {
  return {
    logicalSessionId: "logical:one",
    activeThreadId: "thread:active",
    activeWorkspaceId: "worktree:one",
    repositoryId: "repository:one",
    routingVersion: 3,
    activeBinding: { boundCwd: "/repo/worktree" },
    ...overrides
  };
}

test("accepts a live active worktree and returns routing metadata", async () => {
  const result = await assertWorkspaceRouteUsable({
    store: { getGitWorktree: () => worktree },
    logicalSession: route(),
    providerThreadId: "thread:active",
    inspectWorkspace: async () => ({
      repositoryId: "repository:one",
      worktreeId: "worktree:one",
      canonicalPath: "/repo/worktree"
    })
  });

  assert.deepEqual(result, {
    cwd: "/repo/worktree",
    logicalSessionId: "logical:one",
    providerThreadId: "thread:active",
    worktreeId: "worktree:one",
    routingVersion: 3
  });
});

test("rejects an inactive provider thread", async () => {
  await assert.rejects(
    () => assertWorkspaceRouteUsable({
      store: { getGitWorktree: () => worktree },
      logicalSession: route(),
      providerThreadId: "thread:old"
    }),
    (error) => error.code === "STALE_WORKSPACE_ROUTE" && error.statusCode === 409
  );
});

test("rejects missing and invalidated worktrees", async () => {
  for (const unavailable of [null, { ...worktree, availability: "missing" }]) {
    await assert.rejects(
      () => assertWorkspaceRouteUsable({
        store: { getGitWorktree: () => unavailable },
        logicalSession: route()
      }),
      (error) => error.code === "WORKSPACE_UNAVAILABLE"
    );
  }
});

test("rejects a path that resolves to a different worktree identity", async () => {
  await assert.rejects(
    () => assertWorkspaceRouteUsable({
      store: { getGitWorktree: () => worktree },
      logicalSession: route(),
      inspectWorkspace: async () => ({
        repositoryId: "repository:one",
        worktreeId: "worktree:replacement",
        canonicalPath: "/repo/worktree"
      })
    }),
    (error) => error.code === "WORKSPACE_IDENTITY_CHANGED"
  );
});

test("rejects a deleted active worktree even when the cached inventory is available", async () => {
  await assert.rejects(
    () => assertWorkspaceRouteUsable({
      store: { getGitWorktree: () => worktree },
      logicalSession: route(),
      inspectWorkspace: async () => {
        throw new Error("ENOENT");
      }
    }),
    (error) => error.code === "WORKSPACE_UNAVAILABLE"
  );
});
