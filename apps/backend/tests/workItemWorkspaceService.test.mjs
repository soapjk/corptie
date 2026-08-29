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
    },
    accessWorkspace: async (path) => {
      calls.push(["access", path]);
      if (overrides.accessError) throw overrides.accessError;
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
  assert.deepEqual(calls.map(([name]) => name), ["project", "access", "ensure"]);
  assert.deepEqual(calls[2][1], {
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
  assert.deepEqual(calls.map(([name]) => name), ["project", "access", "inspect", "route"]);
});

test("a stale registered Worktree is rebuilt from its preserved task branch", async () => {
  const stale = {
    worktreeId: "worktree:stale",
    path: "/repo-workitem-one",
    branchName: "workitem/one",
    availability: "prunable",
    isMain: false
  };
  const { service, calls } = createService({
    route: { activeWorkspaceId: stale.worktreeId, logicalSessionId: "logical:one" },
    inspection: { worktrees: [stale] },
    restored: {
      restored: {
        worktreeId: "worktree:restored",
        canonicalPath: "/repo-workitem-one",
        path: "/repo-workitem-one",
        branchName: "workitem/one",
        headOid: "restored-head"
      }
    }
  });

  const result = await service.ensure({ workItem, session: { id: "session:one" } });

  assert.deepEqual(result, {
    worktreeId: "worktree:restored",
    path: "/repo-workitem-one",
    branchName: "workitem/one",
    headOid: "restored-head",
    reused: false,
    rebuilt: true,
    requiresSessionTransition: true
  });
  assert.deepEqual(calls.map(([name]) => name), ["project", "access", "inspect", "route", "restore"]);
  assert.deepEqual(calls.at(-1)[1], { logicalSessionId: "logical:one" });
});

test("a missing Worktree inventory record is recreated through the deterministic WorkItem branch", async () => {
  const { service, calls } = createService({
    route: { activeWorkspaceId: "worktree:missing", logicalSessionId: "logical:one" },
    inspection: { worktrees: [] }
  });

  const result = await service.ensure({ workItem, session: { id: "session:one" } });

  assert.equal(result.worktreeId, "worktree:new");
  assert.equal(result.rebuilt, true);
  assert.equal(result.requiresSessionTransition, true);
  assert.deepEqual(calls.map(([name]) => name), ["project", "access", "inspect", "route", "ensure"]);
  assert.deepEqual(calls.at(-1)[1], {
    repositoryId: "repository:one",
    workingDirectory: "/repo",
    workItemId: "work_item:one"
  });
});

test("Worktree rebuild failure is stable, actionable, and never falls back to a new branch", async () => {
  const stale = {
    worktreeId: "worktree:stale",
    path: "/repo-workitem-one",
    branchName: "workitem/one",
    availability: "prunable",
    isMain: false
  };
  const { service, calls } = createService({
    route: { activeWorkspaceId: stale.worktreeId, logicalSessionId: "logical:one" },
    inspection: { worktrees: [stale] }
  });
  service.restoreMissingWorktree = async () => {
    calls.push(["restore-failed"]);
    throw new Error("The original branch workitem/one no longer exists.");
  };

  await assert.rejects(
    service.ensure({ workItem, session: { id: "session:one" } }),
    (error) => error.code === "WORKTREE_REBUILD_FAILED"
      && error.statusCode === 409
      && /workitem\/one no longer exists/.test(error.message)
  );
  assert.equal(calls.some(([name]) => name === "ensure"), false);
});

test("missing Workspace remains an explicit 409 business error before Git access", async () => {
  const { service, calls } = createService();
  await assert.rejects(
    service.ensure({ workItem: { id: "work_item:no-workspace", main_workspace_id: null } }),
    (error) => error.code === "WORKSPACE_REQUIRED" && error.statusCode === 409
  );
  assert.deepEqual(calls, []);
});

test("stale and inaccessible Workspace bindings report distinct actionable errors", async () => {
  const stale = createService();
  stale.service.requireProject = async () => {
    const error = new Error("missing");
    error.code = "PROJECT_NOT_FOUND";
    throw error;
  };
  await assert.rejects(
    stale.service.ensure({ workItem }),
    (error) => error.code === "WORKSPACE_BINDING_INVALID" && /重新绑定/.test(error.message)
  );

  const inaccessible = createService({ accessError: Object.assign(new Error("denied"), { code: "EACCES" }) });
  await assert.rejects(
    inaccessible.service.ensure({ workItem }),
    (error) => error.code === "WORKSPACE_UNAVAILABLE" && /磁盘挂载/.test(error.message)
  );
});
