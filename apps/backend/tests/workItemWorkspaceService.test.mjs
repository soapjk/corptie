import assert from "node:assert/strict";
import test from "node:test";
import { WorkItemWorkspaceService } from "../src/application/workItemWorkspaceService.mjs";

function createService(overrides = {}) {
  const calls = [];
  const service = new WorkItemWorkspaceService({
    store: {
      getLogicalSessionByLegacySessionId(sessionId) {
        calls.push(["route", sessionId]);
        return overrides.route ?? null;
      }
    },
    requireProject: async (repositoryId) => {
      calls.push(["project", repositoryId]);
      return { id: repositoryId, mainPath: "/repo" };
    },
    inspectProject: async (...args) => {
      calls.push(["inspect", ...args]);
      return overrides.inspection ?? { worktrees: [] };
    },
    ensureWorktree: async (input) => {
      calls.push(["ensure", input]);
      return overrides.ensured ?? {
        worktreeId: "worktree:new",
        path: "/repo-workitem-one",
        branchName: "workitem/one",
        headOid: "abc",
        reused: false
      };
    },
    restoreMissingWorktree: async (input) => {
      calls.push(["restore", input]);
      return overrides.restored;
    }
  });
  return { service, calls };
}

const workItem = {
  id: "work_item:one",
  main_workspace_id: "repository:one"
};

test("first execution skips management inspection and directly ensures the deterministic Worktree", async () => {
  const { service, calls } = createService();
  const result = await service.ensure({ workItem });

  assert.equal(result.worktreeId, "worktree:new");
  assert.equal(result.requiresSessionTransition, false);
  assert.deepEqual(calls.map(([name]) => name), ["project", "ensure"]);
  assert.deepEqual(calls[1][1], {
    repositoryId: "repository:one",
    workingDirectory: "/repo",
    workItemId: "work_item:one"
  });
});

test("existing Session execution preserves route inspection and Worktree reuse semantics", async () => {
  const existing = {
    worktreeId: "worktree:existing",
    canonicalPath: "/canonical-existing",
    path: "/existing",
    branchName: "workitem/one",
    headOid: "def",
    availability: "available",
    isMain: false
  };
  const { service, calls } = createService({
    route: { activeWorkspaceId: existing.worktreeId, logicalSessionId: "logical:one" },
    inspection: { worktrees: [existing] }
  });
  const result = await service.ensure({ workItem, session: { id: "session:one" } });

  assert.deepEqual(result, {
    worktreeId: existing.worktreeId,
    path: existing.canonicalPath,
    branchName: existing.branchName,
    headOid: existing.headOid,
    reused: true,
    requiresSessionTransition: false
  });
  assert.deepEqual(calls.map(([name]) => name), ["project", "inspect", "route"]);
});

test("missing Workspace remains an explicit 409 business error before Git access", async () => {
  const { service, calls } = createService();
  await assert.rejects(
    service.ensure({ workItem: { id: "work_item:no-workspace", main_workspace_id: null } }),
    (error) => error.code === "WORKSPACE_REQUIRED" && error.statusCode === 409
  );
  assert.deepEqual(calls, []);
});
