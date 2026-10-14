import test from "node:test";
import assert from "node:assert/strict";
import { createWorktreeIntegrationServices } from "../src/application/worktreeIntegrationComposition.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const store = {
    resolveWorkspacePath: () => "/main",
    listTasks: () => [],
    getTask: () => ({ id: "task", work_id: "work", title: "Conflict", main_agent_id: "agent" }),
    getSession: () => ({ id: "session", title: "Session", cwd: "/integration" }),
    getWorktreeIntegrationJobByIdempotencyKey: () => null,
    selectOne: () => null,
    createWorktreeIntegrationJobIdempotently: (input) => input,
    getAgent: () => ({ agentId: "agent", name: "Agent" }),
    getWork: () => ({ id: "work" })
  };
  const dependencies = {
    store,
    projectApplicationService: { requireProject: async () => ({ id: "project", mainPath: "/main" }) },
    gitWorkspaces: {
      projectStatusForPath: (...args) => calls.push(["inspect", ...args]),
      integrationInspectionForProject: (...args) => {
        calls.push(["integration-inspect", ...args]);
        return { worktrees: [] };
      },
      mergeWorktreeIntoMainForProject: (input) => calls.push(["merge", input])
    },
    gitHubPushes: {}, gitCommitProtection: {},
    workService: {
      createTask: () => ({ id: "created" }),
      deleteTask: (id) => calls.push(["delete", id]),
      updateTask: (...args) => calls.push(["update", ...args])
    },
    agentProviderRegistry: { defaultProviderId: "test-provider" },
    startPreparedWorkSession: async (input) => { calls.push(["start", input]); return { id: "created-session" }; },
    sendUnifiedSessionMessage: async (...args) => calls.push(["send", ...args]),
    admitReliableSessionMessage: async (...args) => calls.push(["admit", ...args]),
    emitEvent: (...args) => calls.push(["event", ...args]),
    presentTaskForClient: (task) => task,
    ...overrides
  };
  return { ...createWorktreeIntegrationServices(dependencies), store, calls };
}

function conflictInput() {
  return {
    job: { id: "worktree_integration:plan", conflictAutomation: { taskId: "task", sessionId: "session", agentId: "agent" } },
    item: { worktreeId: "source", conflictFiles: ["source.swift"] },
    workspace: { path: "/integration" }, sourceHead: "source-head", expectedMainHead: "main-head"
  };
}

test("composition preserves shared Store and explicit integration Git options", async () => {
  const { projectWorktreeIntegrationService: project, worktreeIntegrationJobService: jobs, store, calls } = fixture();
  assert.equal(project.store, store);
  assert.equal(jobs.store, store);
  assert.deepEqual(calls, []);
  await project.inspectProject("project");
  await jobs.inspectRepository("repository", {
    forceFresh: true,
    reason: "integration_candidate_confirmation",
    cacheTtlMs: 0
  });
  await project.mergeWorktree({ projectId: "project", mainPath: "/main", worktreeId: "source" });
  assert.deepEqual(calls, [
    ["inspect", "/main", "project", { inspectionLevel: "integration", reason: "integration_status" }],
    ["integration-inspect", "/main", "repository", {
      forceFresh: true,
      reason: "integration_candidate_confirmation",
      cacheTtlMs: 0
    }],
    ["merge", { repositoryId: "project", workingDirectory: "/main", sourceWorktreeId: "source", synchronizeSource: false }]
  ]);
});

test("an existing plan reuses its Session and sends through the common execution boundary", async () => {
  const { worktreeIntegrationJobService: jobs, calls } = fixture();
  const result = await jobs.launchConflictResolution(conflictInput());
  assert.equal(result.reused, true);
  assert.equal(result.sessionId, "session");
  assert.deepEqual(calls.map(([kind]) => kind), ["update", "admit"]);
  const [, sessionId, prompt, source, options] = calls[1];
  assert.equal(sessionId, "session");
  assert.ok(prompt.includes("source-head"));
  assert.equal(source.type, "worktree-integration");
  assert.equal(source.localVisibility, "normal");
  assert.match(source.messageId, /^integration-conflict:/);
  assert.match(source.deliveryId, /^delivery:integration-conflict:/);
  assert.equal(options, undefined);
});

test("a new plan Session atomically starts with exactly one conflict prompt", async () => {
  const { worktreeIntegrationJobService: jobs, calls } = fixture();
  const item = {
    worktreeId: "source",
    branchName: "feature/source",
    conflictFiles: ["source.swift"],
    associations: [{ taskId: "task" }]
  };
  const result = await jobs.launchConflictResolution({
    job: { id: "worktree_integration:new-plan", plan: { items: [item] } },
    item,
    workspace: { path: "/integration" },
    sourceHead: "source-head",
    expectedMainHead: "main-head"
  });

  assert.equal(result.reused, false);
  assert.deepEqual(calls.map(([kind]) => kind), ["start"]);
  assert.equal(calls[0][1].dispatchInitialTurn, true);
  assert.ok(calls[0][1].initialPrompt.includes("source-head"));
  assert.equal(calls.filter(([kind]) => ["send", "admit"].includes(kind)).length, 0);
});

test("a recorded plan with a missing Session never creates a duplicate Task", async () => {
  const { worktreeIntegrationJobService: jobs, store, calls } = fixture();
  store.getSession = () => null;
  await assert.rejects(jobs.launchConflictResolution(conflictInput()), { code: "CONFLICT_PLAN_SESSION_UNAVAILABLE" });
  assert.deepEqual(calls, []);
});

test("a plan startup whose first Turn failed resumes the same Task and startup operation", async () => {
  const { worktreeIntegrationJobService: jobs, store, calls } = fixture();
  store.getSession = () => null;
  store.selectOne = () => ({ source_session_id: "logical:source" });
  const item = {
    worktreeId: "source",
    branchName: "feature/source",
    conflictFiles: ["source.swift"]
  };
  const result = await jobs.launchConflictResolution({
    job: {
      id: "worktree_integration:plan",
      conflictAutomation: { taskId: "task", sessionId: "missing", agentId: "agent" },
      plan: { items: [item] }
    },
    item,
    workspace: { path: "/integration" },
    sourceHead: "source-head",
    expectedMainHead: "main-head"
  });
  assert.equal(result.taskId, "task");
  assert.equal(result.sessionId, "created-session");
  assert.equal(result.reused, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["start"]);
  assert.equal(calls[0][1].idempotencyKey, "integration-plan:worktree_integration:plan:start");
  assert.equal(calls[0][1].sourceSessionId, "logical:source");
  assert.ok(calls[0][1].initialPrompt.includes("source-head"));
});

test("a plan Session bound to a different worktree is rejected before mutation", async () => {
  const { worktreeIntegrationJobService: jobs, store, calls } = fixture();
  store.getSession = () => ({ id: "session", cwd: "/different" });
  await assert.rejects(jobs.launchConflictResolution(conflictInput()), { code: "CONFLICT_PLAN_SESSION_WORKSPACE_CHANGED" });
  assert.deepEqual(calls, []);
});

test("failed conflict Session startup rolls back the newly created Task", async () => {
  const error = new Error("launch failed");
  const { projectWorktreeIntegrationService: project, calls } = fixture({
    startPreparedWorkSession: async () => { throw error; }
  });
  await assert.rejects(project.createAndLaunchConflictTask({
    work: { id: "work" }, agent: { agentId: "agent" }, workspace: { path: "/integration" },
    title: "Conflict", integrationRunId: "run"
  }), (failure) => failure === error);
  assert.deepEqual(calls, [["delete", "created"]]);
});
