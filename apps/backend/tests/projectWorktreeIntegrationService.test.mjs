import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProjectWorktreeIntegrationService,
  conflictFilesFromError,
  integrationCounts,
  presentProjectIntegrationRun
} from "../src/application/projectWorktreeIntegrationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

function fixture() {
  const objective = {
    id: "objective:1",
    name: "Objective",
    workspaceIds: ["repository:1"],
    contributorAgentIds: ["agent:1"]
  };
  const workItems = [
    {
      id: "work_item:1", objective_id: objective.id, title: "First",
      current_session_id: "session:1", execution_status: "completed", status: "in_progress",
      updated_at: "2026-08-18T01:00:00.000Z"
    },
    {
      id: "work_item:2", objective_id: objective.id, title: "Second",
      current_session_id: "session:2", execution_status: "completed", status: "in_progress",
      updated_at: "2026-08-18T02:00:00.000Z"
    }
  ];
  const sessions = new Map([
    ["session:1", { id: "session:1", workItemId: "work_item:1", status: "complete" }],
    ["session:2", { id: "session:2", workItemId: "work_item:2", status: "complete" }]
  ]);
  const runs = new Map();
  const store = {
    getObjective: (id) => id === objective.id ? objective : null,
    listWorkItemsByObjective: (id) => id === objective.id ? workItems : [],
    getSession: (id) => sessions.get(id) ?? null,
    getAgent: (id) => id === "agent:1"
      ? { agentId: id, name: "Integrator", provider: "codex", role: "independentContributor" }
      : null,
    getWorkItem: (id) => workItems.find((item) => item.id === id) ?? null,
    createProjectIntegrationRun(input) {
      const run = {
        id: "integration:1", repositoryId: input.repositoryId, objectiveId: input.objectiveId,
        status: "running", mainHeadBefore: input.mainHeadBefore, mainHeadAfter: null,
        conflictWorkItemId: null, conflictSessionId: null,
        integrationWorktreeId: null, integrationWorktreePath: null, integrationBranch: null,
        items: input.items.map((item) => ({
          runId: "integration:1", ...item, status: "pending", conflictFiles: [],
          mergedMainHead: null, error: null
        }))
      };
      runs.set(run.id, run);
      return structuredClone(run);
    },
    getProjectIntegrationRun(id) {
      const run = runs.get(id);
      return run ? structuredClone(run) : null;
    },
    getLatestProjectIntegrationRun() {
      return runs.size > 0 ? structuredClone([...runs.values()].at(-1)) : null;
    },
    updateProjectIntegrationItem(runId, worktreeId, patch) {
      const run = runs.get(runId);
      const item = run.items.find((entry) => entry.worktreeId === worktreeId);
      Object.assign(item, patch);
      return structuredClone(item);
    },
    updateProjectIntegrationRun(id, patch) {
      const run = runs.get(id);
      Object.assign(run, patch);
      return structuredClone(run);
    }
  };
  const state = {
    mainHeadOid: "main:1",
    worktrees: [
      { worktreeId: "main", isMain: true, availability: "available", headOid: "main:1" },
      {
        worktreeId: "wt:1", isMain: false, availability: "available", dirty: false,
        mergedIntoMain: false, branchName: "feature/one", headOid: "head:1",
        sessions: [{ sessionId: "session:1" }]
      },
      {
        worktreeId: "wt:2", isMain: false, availability: "available", dirty: false,
        mergedIntoMain: false, branchName: "feature/two", headOid: "head:2",
        sessions: [{ sessionId: "session:2" }]
      }
    ]
  };
  const inspection = () => ({
    repositoryId: "repository:1",
    mainPath: "/repo",
    mainHeadOid: state.mainHeadOid,
    worktrees: structuredClone(state.worktrees)
  });
  return { store, state, inspection, workItems, sessions };
}

test("integration run presenter supplies the complete client wire contract", () => {
  const presented = presentProjectIntegrationRun({
    id: "integration:1",
    items: [
      { workItemId: "work_item:1", status: "integrated" },
      { workItemId: "work_item:missing", status: "conflict" }
    ]
  }, {
    resolveWorkItem: (id) => id === "work_item:1" ? { title: "Resolved title" } : null
  });

  assert.deepEqual(presented.counts, {
    total: 2,
    integrated: 1,
    conflicts: 1,
    failed: 0,
    pending: 0
  });
  assert.deepEqual(
    presented.items.map((item) => item.workItemTitle),
    ["Resolved title", "work_item:missing"]
  );
});

test("status exposes completed Objective Worktrees and scoped contributor Agents", async () => {
  const { store, inspection } = fixture();
  const service = new ProjectWorktreeIntegrationService({
    store,
    inspectProject: async () => inspection(),
    mergeWorktree: async () => ({ mainHead: "unused" }),
    createConflictWorkspace: async () => ({}),
    createAndLaunchConflictWorkItem: async () => ({})
  });

  const status = await service.status("repository:1", "objective:1");

  assert.deepEqual(status.eligibleWorktrees.map((item) => item.worktreeId), ["wt:1", "wt:2"]);
  assert.deepEqual(status.eligibleAgents.map((agent) => agent.agentId), ["agent:1"]);
});

test("one-click integration serially merges clean Worktrees and records conflicts without stopping", async () => {
  const { store, state, inspection } = fixture();
  const attempts = [];
  const service = new ProjectWorktreeIntegrationService({
    store,
    inspectProject: async () => inspection(),
    mergeWorktree: async ({ worktreeId }) => {
      attempts.push(worktreeId);
      if (worktreeId === "wt:1") {
        state.mainHeadOid = "main:2";
        state.worktrees.find((item) => item.worktreeId === worktreeId).mergedIntoMain = true;
        return { mainHead: state.mainHeadOid };
      }
      throw new Error([
        "Could not merge the worktree into main:",
        "CONFLICT (content): Merge conflict in apps/backend/src/server.mjs",
        "Automatic merge failed"
      ].join("\n"));
    },
    createConflictWorkspace: async () => ({}),
    createAndLaunchConflictWorkItem: async () => ({})
  });

  const result = await service.integrateCompleted("repository:1", "objective:1");

  assert.deepEqual(attempts, ["wt:1", "wt:2"]);
  assert.equal(result.latestRun.status, "conflicts_detected");
  assert.deepEqual(result.latestRun.counts, {
    total: 2, integrated: 1, conflicts: 1, failed: 0, pending: 0
  });
  assert.deepEqual(
    result.latestRun.items.find((item) => item.worktreeId === "wt:2").conflictFiles,
    ["apps/backend/src/server.mjs"]
  );
  await assert.rejects(
    () => service.integrateCompleted("repository:1", "objective:1"),
    (error) => error?.code === "UNRESOLVED_INTEGRATION_CONFLICTS"
  );
});

test("one-click integration completes every eligible Worktree and updates the final main head", async () => {
  const { store, state, inspection } = fixture();
  const attempts = [];
  const service = new ProjectWorktreeIntegrationService({
    store,
    inspectProject: async () => inspection(),
    mergeWorktree: async ({ worktreeId }) => {
      attempts.push(worktreeId);
      state.mainHeadOid = `main:${attempts.length + 1}`;
      state.worktrees.find((item) => item.worktreeId === worktreeId).mergedIntoMain = true;
      return { mainHead: state.mainHeadOid };
    },
    createConflictWorkspace: async () => ({}),
    createAndLaunchConflictWorkItem: async () => ({})
  });

  const result = await service.integrateCompleted("repository:1", "objective:1");

  assert.deepEqual(attempts, ["wt:1", "wt:2"]);
  assert.equal(result.latestRun.status, "integrated");
  assert.equal(result.latestRun.mainHeadAfter, "main:3");
  assert.deepEqual(result.latestRun.counts, {
    total: 2, integrated: 2, conflicts: 0, failed: 0, pending: 0
  });
  assert.deepEqual(result.eligibleWorktrees, []);
});

test("one-click integration rejects a concurrent duplicate while the first run continues", async () => {
  const { store, state, inspection } = fixture();
  let releaseFirstMerge;
  const firstMergeStarted = new Promise((resolve) => { releaseFirstMerge = resolve; });
  let unblockFirstMerge;
  const firstMergeBlocked = new Promise((resolve) => { unblockFirstMerge = resolve; });
  const service = new ProjectWorktreeIntegrationService({
    store,
    inspectProject: async () => inspection(),
    mergeWorktree: async ({ worktreeId }) => {
      if (worktreeId === "wt:1") {
        releaseFirstMerge();
        await firstMergeBlocked;
      }
      state.worktrees.find((item) => item.worktreeId === worktreeId).mergedIntoMain = true;
      state.mainHeadOid = worktreeId === "wt:1" ? "main:2" : "main:3";
      return { mainHead: state.mainHeadOid };
    },
    createConflictWorkspace: async () => ({}),
    createAndLaunchConflictWorkItem: async () => ({})
  });

  const first = service.integrateCompleted("repository:1", "objective:1");
  await firstMergeStarted;
  await assert.rejects(
    () => service.integrateCompleted("repository:1", "objective:1"),
    (error) => error?.code === "INTEGRATION_ALREADY_RUNNING" && error?.statusCode === 409
  );
  unblockFirstMerge();

  const result = await first;
  assert.equal(result.latestRun.status, "integrated");
  assert.equal(result.latestRun.counts.integrated, 2);
});

test("conflict parser and counters keep Git conflicts separate from other failures", () => {
  assert.deepEqual(conflictFilesFromError(new Error(
    "CONFLICT (content): Merge conflict in a.mjs\nCONFLICT (add/add): Merge conflict in b.swift"
  )), ["a.mjs", "b.swift"]);
  assert.deepEqual(integrationCounts([
    { status: "integrated" }, { status: "already_integrated" },
    { status: "conflict" }, { status: "failed" }, { status: "pending" }
  ]), { total: 5, integrated: 2, conflicts: 1, failed: 1, pending: 1 });
});

test("conflict resolution creates one Objective WorkItem in a dedicated Integration Worktree and reuses it", async () => {
  const { store, state, inspection, workItems, sessions } = fixture();
  let workspaceCreations = 0;
  let launches = 0;
  let launchInput = null;
  const service = new ProjectWorktreeIntegrationService({
    store,
    inspectProject: async () => inspection(),
    mergeWorktree: async () => {
      throw new Error("CONFLICT (content): Merge conflict in shared.swift");
    },
    createConflictWorkspace: async () => {
      workspaceCreations += 1;
      return {
        worktreeId: "wt:integration",
        path: "/repo-integration",
        branchName: "integration/one"
      };
    },
    createAndLaunchConflictWorkItem: async (input) => {
      launches += 1;
      launchInput = input;
      const workItem = {
        id: "work_item:resolution",
        objective_id: "objective:1",
        title: input.title
      };
      const session = {
        id: "session:resolution",
        workItemId: workItem.id,
        status: "running"
      };
      workItems.push(workItem);
      sessions.set(session.id, session);
      return { workItem, session };
    }
  });
  const integrated = await service.integrateCompleted("repository:1", "objective:1");

  const created = await service.createConflictWorkItem(
    "repository:1",
    "objective:1",
    integrated.latestRun.id,
    { agentId: "agent:1" }
  );
  const reused = await service.createConflictWorkItem(
    "repository:1",
    "objective:1",
    integrated.latestRun.id,
    { agentId: "agent:1" }
  );

  assert.equal(workspaceCreations, 1);
  assert.equal(launches, 1);
  assert.equal(created.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(created.run.status, "conflict_resolution_running");
  assert.equal(created.run.integrationWorktreePath, "/repo-integration");
  assert.equal(created.run.conflictWorkItemId, "work_item:resolution");
  assert.equal(launchInput.objective.id, "objective:1");
  assert.equal(launchInput.agent.agentId, "agent:1");
  assert.equal(launchInput.workspace.path, "/repo-integration");
  assert.match(launchInput.prompt, /不得推送远端/);
  assert.deepEqual(
    launchInput.prompt.match(/feature\/(one|two)/g),
    ["feature/one", "feature/two"]
  );
  assert.equal(state.mainHeadOid, "main:1");

  state.mainHeadOid = "main:resolved";
  for (const worktree of state.worktrees.filter((item) => !item.isMain)) {
    worktree.mergedIntoMain = true;
  }
  const reconciled = await service.status("repository:1", "objective:1");
  assert.equal(reconciled.latestRun.status, "integrated");
  assert.deepEqual(reconciled.latestRun.counts, {
    total: 2, integrated: 2, conflicts: 0, failed: 0, pending: 0
  });
});

test("Integration Runs and per-Worktree results persist in the Corptie store", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-integration-store-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite") });
  try {
    await store.initialize();
    const run = store.createProjectIntegrationRun({
      repositoryId: "repository:1",
      objectiveId: "objective:1",
      mainHeadBefore: "main:1",
      items: [{
        worktreeId: "wt:1",
        workItemId: "work_item:1",
        branchName: "feature/one",
        sourceHeadOid: "head:1"
      }]
    });
    store.updateProjectIntegrationItem(run.id, "wt:1", {
      status: "conflict",
      conflictFiles: ["server.mjs"],
      error: "merge conflict"
    });
    store.updateProjectIntegrationRun(run.id, {
      status: "conflicts_detected",
      mainHeadAfter: "main:1",
      completedAt: "2026-08-18T03:00:00.000Z"
    });

    const saved = store.getLatestProjectIntegrationRun("repository:1", "objective:1");
    assert.equal(saved.status, "conflicts_detected");
    assert.deepEqual(saved.items[0].conflictFiles, ["server.mjs"]);
    assert.equal(saved.items[0].error, "merge conflict");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
