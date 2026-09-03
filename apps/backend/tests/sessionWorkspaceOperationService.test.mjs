import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionWorkspaceOperationService } from "../src/application/sessionWorkspaceOperationService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-workspace-operation-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  const creates = [];
  const switches = [];
  const audit = [];
  const worktrees = {
    async createWorktree(sessionId, input) {
      creates.push({ sessionId, input });
      return {
        repositoryId: input.logicalSessionId.includes("one") ? "repository:one" : "repository:two",
        worktree: { worktreeId: `worktree:${input.logicalSessionId}`, path: input.targetPath },
        transition: input.switchAfterCreate === false ? null : { status: "waitingForTurn" }
      };
    },
    async switchWorkspace(sessionId, worktreeId, checkpoint) {
      switches.push({ sessionId, worktreeId, checkpoint });
      return { status: "waitingForTurn" };
    }
  };
  const service = new SessionWorkspaceOperationService({
    store,
    collaborationCore: core,
    worktrees,
    inventory: (logical) => ({
      logicalSessionId: logical.logicalSessionId,
      activeWorktreeId: logical.activeWorkspaceId,
      activeRepositoryId: logical.repositoryId,
      workspaces: [
        { id: "worktree:one", repositoryId: "repository:one" },
        { id: "worktree:two", repositoryId: "repository:two" }
      ]
    }),
    onAudit: (record) => audit.push(record)
  });
  return { directory, store, core, service, creates, switches, audit };
}

function addRepository(store, id) {
  const suffix = id.split(":").at(-1);
  const timestamp = new Date().toISOString();
  const workspace = store.createWorkspace({
    workspaceId: `workspace:${suffix}`,
    kind: "linkedLocal",
    ownership: "userManaged",
    rootPath: `/repo/${suffix}`,
    canonicalRootPath: `/repo/${suffix}`
  });
  store.db.run(
    "INSERT INTO git_repositories (repository_id, workspace_id, common_git_dir, discovered_at, last_validated_at) VALUES (?, ?, ?, ?, ?)",
    [id, workspace.workspaceId, `/git/${suffix}`, timestamp, timestamp]
  );
  store.db.run(
    `INSERT INTO git_worktrees (
      worktree_id, repository_id, path, canonical_path, git_dir, is_main, availability,
      detached, locked, prunable, inventory_version, observed_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'available', 0, 0, 0, 'inventory:1', ?)`,
    [`worktree:${suffix}`, id, `/repo/${suffix}`, `/repo/${suffix}`, `/git/${suffix}/worktrees/main`, timestamp]
  );
  return workspace.workspaceId;
}

function addScopedSession(f, suffix, options = {}) {
  const agent = f.store.createAgent({ id: `agent:${suffix}`, name: `Agent ${suffix}`, role: "independentContributor" });
  const repositoryId = `repository:${suffix}`;
  const workspaceId = addRepository(f.store, repositoryId);
  const work = f.store.createWork({
    id: `work:${suffix}`,
    name: `Work ${suffix}`,
    contributorAgentIds: options.contributor === false ? [] : [agent.agentId],
    workspaceId
  });
  const task = f.store.createTask({ workId: work.id, title: `Work ${suffix}` });
  const providerSessionId = `provider:${suffix}`;
  const logicalSessionId = `logical:${suffix}`;
  f.store.createSession({
    id: providerSessionId,
    title: `Session ${suffix}`,
    agentId: agent.agentId,
    sessionKind: "worker",
    workId: work.id,
    taskId: task.id
  });
  f.store.createLogicalSessionRoute({
    logicalSessionId,
    legacySessionId: providerSessionId,
    providerThreadId: `thread:${suffix}`,
    providerSessionId,
    providerId: "test-provider",
    boundCwd: `/repo/${suffix}`,
    sessionName: `Session ${suffix}`
  });
  f.store.db.run(
    "UPDATE logical_sessions SET repository_id=?, active_workspace_id=? WHERE logical_session_id=?",
    [repositoryId, `worktree:${suffix}`, logicalSessionId]
  );
  f.core.bindSession({ agentId: agent.agentId, sessionId: providerSessionId });
  return {
    agentId: agent.agentId,
    workId: work.id,
    taskId: task.id,
    providerSessionId,
    logicalSessionId,
    repositoryId,
    metadata: { sessionId: providerSessionId, workId: work.id, taskId: task.id }
  };
}

test("two Sessions in different Works create Workspaces with exact source context and repository isolation", async () => {
  const f = await fixture();
  try {
    const one = addScopedSession(f, "one");
    const two = addScopedSession(f, "two");
    const first = await f.service.createWorktree(one.metadata, one.agentId, {
      target_path: "/targets/one", branch: "feature/one", switch_after_create: false,
      idempotency_key: "create:one"
    });
    const second = await f.service.createWorktree(two.metadata, two.agentId, {
      target_path: "/targets/two", branch: "feature/two", idempotency_key: "create:two"
    });

    assert.equal(first.sourceContext.workId, one.workId);
    assert.equal(first.sourceContext.sourceSessionId, one.logicalSessionId);
    assert.equal(first.sourceContext.repositoryId, one.repositoryId);
    assert.equal(second.sourceContext.workId, two.workId);
    assert.equal(second.sourceContext.sourceSessionId, two.logicalSessionId);
    assert.deepEqual(f.creates.map((call) => call.sessionId), [one.providerSessionId, two.providerSessionId]);
    assert.deepEqual((await f.service.listWorkspaces(one.metadata, one.agentId)).workspaces.map((item) => item.repositoryId), [one.repositoryId]);
    assert.deepEqual((await f.service.listWorkspaces(two.metadata, two.agentId)).workspaces.map((item) => item.repositoryId), [two.repositoryId]);
    assert.equal(f.audit.filter((entry) => entry.event === "workspace_creation_succeeded").length, 2);
    assert.deepEqual(
      f.store.selectAll("SELECT work_id, source_session_id, status FROM workspace_creation_requests ORDER BY work_id"),
      [
        { work_id: one.workId, source_session_id: one.providerSessionId, status: "succeeded" },
        { work_id: two.workId, source_session_id: two.providerSessionId, status: "succeeded" }
      ]
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("regression: both legacy Agent-current-session lookups fail even though each source Session has a valid Work route", async () => {
  const f = await fixture();
  try {
    const one = addScopedSession(f, "one");
    const two = addScopedSession(f, "two");
    f.store.db.run("UPDATE agents SET current_session_id=NULL WHERE agent_id IN (?, ?)", [one.agentId, two.agentId]);

    const legacyRequireAgentLogicalSession = (agentId) => {
      const currentSessionId = f.core.getAgent(agentId)?.currentSessionId;
      const logical = currentSessionId ? f.store.getLogicalSessionByLegacySessionId(currentSessionId) : null;
      if (!currentSessionId || !logical?.activeBinding) {
        const error = new Error("The Corptie Agent is not bound to an active logical Session.");
        error.code = "SESSION_NOT_FOUND";
        throw error;
      }
      return logical;
    };

    assert.throws(() => legacyRequireAgentLogicalSession(one.agentId), {
      code: "SESSION_NOT_FOUND",
      message: "The Corptie Agent is not bound to an active logical Session."
    });
    assert.throws(() => legacyRequireAgentLogicalSession(two.agentId), {
      code: "SESSION_NOT_FOUND",
      message: "The Corptie Agent is not bound to an active logical Session."
    });

    const first = await f.service.createWorktree(one.metadata, one.agentId, {
      target_path: "/targets/regression-one", idempotency_key: "regression:one"
    });
    const second = await f.service.createWorktree(two.metadata, two.agentId, {
      target_path: "/targets/regression-two", idempotency_key: "regression:two"
    });
    assert.equal(first.sourceContext.workId, one.workId);
    assert.equal(second.sourceContext.workId, two.workId);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Workspace creation rejects missing, mismatched, and unauthorized Work context with a failure stage", async () => {
  const f = await fixture();
  try {
    const scoped = addScopedSession(f, "one");
    await assert.rejects(
      () => f.service.createWorktree({}, scoped.agentId, { target_path: "/targets/missing" }),
      { code: "WORKSPACE_SESSION_CONTEXT_REQUIRED", stage: "context_validation" }
    );
    await assert.rejects(
      () => f.service.createWorktree({ ...scoped.metadata, workId: "work:other" }, scoped.agentId, { target_path: "/targets/mismatch" }),
      { code: "WORKSPACE_WORK_CONTEXT_MISMATCH", stage: "context_validation" }
    );
    await assert.rejects(
      () => f.service.createWorktree(scoped.metadata, "agent:other", { target_path: "/targets/forbidden" }),
      { code: "WORKSPACE_ACTOR_FORBIDDEN", stage: "authorization" }
    );
    // Simulate stale authorization data below the product write boundary; public
    // Work updates correctly reject removing the final contributor.
    f.store.db.run("DELETE FROM work_contributors WHERE work_id=?", [scoped.workId]);
    await assert.rejects(
      () => f.service.createWorktree(scoped.metadata, scoped.agentId, { target_path: "/targets/outside" }),
      { code: "WORKSPACE_WORK_ACCESS_DENIED", stage: "authorization" }
    );
    assert.deepEqual(
      f.audit.filter((entry) => entry.event === "workspace_creation_rejected").map((entry) => entry.failureStage),
      ["context_validation", "context_validation", "authorization", "authorization"]
    );
    assert.equal(f.creates.length, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("identical Workspace retries replay the persisted result while conflicting retries are rejected", async () => {
  const f = await fixture();
  try {
    const scoped = addScopedSession(f, "one");
    const input = {
      target_path: "/targets/idempotent", branch: "feature/idempotent",
      switch_after_create: false, idempotency_key: "create:idempotent"
    };
    const created = await f.service.createWorktree(scoped.metadata, scoped.agentId, input);
    const replay = await f.service.createWorktree(scoped.metadata, scoped.agentId, input);
    assert.equal(replay.request.operationId, created.request.operationId);
    assert.equal(replay.request.idempotentReplay, true);
    assert.equal(f.creates.length, 1);
    await assert.rejects(
      () => f.service.createWorktree(scoped.metadata, scoped.agentId, { ...input, branch: "feature/different" }),
      { code: "WORKSPACE_IDEMPOTENCY_CONFLICT", stage: "idempotency" }
    );
    assert.equal(f.audit.some((entry) => entry.event === "workspace_creation_replayed"), true);
    f.store.deleteWork(scoped.workId);
    assert.equal(f.store.getWork(scoped.workId), null);
    assert.equal(
      f.store.selectOne("SELECT work_id FROM workspace_creation_requests WHERE operation_id=?", [created.request.operationId]).work_id,
      scoped.workId,
      "audit identity is retained without owning or blocking Work lifecycle"
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
