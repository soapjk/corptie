import assert from "node:assert/strict";
import test from "node:test";

import { SessionWorktreeService } from "../src/application/sessionWorktreeService.mjs";

test("creating and switching a worktree delegates migration through the Provider-neutral coordinator", async () => {
  const calls = [];
  const service = new SessionWorktreeService({
    gitWorkspaces: {
      async createWorktree(input) {
        calls.push(["create", input]);
        return { worktree: { worktreeId: "worktree:new", path: "/repo-new" } };
      }
    },
    workspaceCoordinator: {
      async switchWorkspace(sessionId, input) {
        calls.push(["switch", sessionId, input]);
        return { status: "waitingForTurn" };
      }
    }
  });

  const result = await service.createWorktree("claude-session", {
    logicalSessionId: "logical-session",
    targetPath: "/repo-new",
    branch: "feature/new",
    continuationPrompt: "Continue the remaining implementation"
  });

  assert.equal(calls[0][1].switchAfterCreate, false);
  assert.deepEqual(calls[1], ["switch", "claude-session", {
    targetWorkspaceId: "worktree:new",
    continuationPrompt: "Continue the remaining implementation"
  }]);
  assert.equal(result.transition.status, "waitingForTurn");
});

test("creating without switching never invokes the Workspace Coordinator", async () => {
  let switched = false;
  const service = new SessionWorktreeService({
    gitWorkspaces: {
      async createWorktree() {
        return { worktree: { worktreeId: "worktree:new" } };
      }
    },
    workspaceCoordinator: {
      async switchWorkspace() { switched = true; }
    }
  });

  const result = await service.createWorktree("session", {
    logicalSessionId: "logical",
    targetPath: "/repo-new",
    switchAfterCreate: false
  });

  assert.equal(switched, false);
  assert.equal(result.transition, null);
});
