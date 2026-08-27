import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkItemStartService } from "../src/application/workItemStartService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-item-start-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  const objectiveService = new ObjectiveApplicationService({ store });
  const agent = store.createAgent({ id: "agent:worker", name: "Worker", role: "independentContributor" });
  const objective = objectiveService.createObjective({
    id: "objective:one",
    name: "Objective",
    contributorAgentIds: [agent.agentId]
  });
  const workItem = objectiveService.createWorkItem({
    id: "work_item:one",
    objectiveId: objective.id,
    title: "Duplicated title",
    mainAgentId: agent.agentId
  });
  const calls = { validate: 0, workspace: 0, create: 0, finalize: 0, activate: 0 };
  const audits = [];
  const createWorkerSession = async ({ providerId, workspace }) => {
    calls.create += 1;
    const id = `provider:worker:${calls.create}`;
    store.createSession({
      id,
      title: workItem.title,
      provider: providerId,
      agentId: agent.agentId,
      sessionKind: "worker",
      objectiveId: objective.id,
      workItemId: workItem.id,
      cwd: workspace.path
    });
    store.createLogicalSessionRoute({
      logicalSessionId: `session:worker:${calls.create}`,
      legacySessionId: id,
      providerThreadId: `thread:${calls.create}`,
      providerSessionId: id,
      providerId,
      boundCwd: workspace.path,
      sessionName: `${workItem.title} ${calls.create}`
    });
    core.bindSession({ agentId: agent.agentId, sessionId: id });
    return store.getSession(id);
  };
  const service = new WorkItemStartService({
    store,
    validateStart: async (operation) => {
      calls.validate += 1;
      return { workItem: store.getWorkItem(operation.workItemId), agent, providerId: operation.providerId };
    },
    prepareWorkspace: async () => {
      calls.workspace += 1;
      return {
        worktreeId: "worktree:one",
        path: join(directory, "repo-workitem-one"),
        branchName: "workitem/one",
        reused: calls.workspace > 1
      };
    },
    createSession: createWorkerSession,
    finalizeStart: (input) => {
      calls.finalize += 1;
      return store.finalizeWorkItemStart(input);
    },
    activateSession: ({ session, workItem: activatedWorkItem }) => {
      calls.activate += 1;
      assert.equal(activatedWorkItem.id, workItem.id);
      const bound = store.getWorkItem(workItem.id);
      assert.equal(bound.current_session_id, session.id);
      assert.equal(store.getSession(session.id).workItemId, workItem.id);
    },
    onAudit: (entry, metadata) => audits.push({ entry, metadata }),
    ...overrides
  });
  return { directory, store, core, objectiveService, agent, objective, workItem, calls, audits, service, createWorkerSession };
}

function startInput(providerId = "codex-app-server") {
  return {
    workItemId: "work_item:one",
    agentId: "agent:worker",
    providerId,
    idempotencyKey: "start:stable",
    title: "Duplicated title",
    source: "test"
  };
}

async function cleanup(f) {
  await f.store.close();
  await rm(f.directory, { recursive: true, force: true });
}

test("Workspace success followed by Provider failure persists the exact stage, audit, and retryable Worktree", async () => {
  const f = await fixture();
  try {
    f.service.createSession = async () => {
      f.calls.create += 1;
      const error = new Error("authorization token=super-secret unavailable");
      error.code = "PROVIDER_UNAVAILABLE";
      throw error;
    };
    await assert.rejects(() => f.service.start(startInput()), { code: "PROVIDER_UNAVAILABLE" });
    const failed = f.store.getWorkItem(f.workItem.id);
    assert.equal(failed.execution_status, "start_failed");
    assert.equal(failed.start_stage, "failed");
    assert.equal(failed.start_failure_stage, "creatingSession");
    assert.equal(failed.start_error_code, "PROVIDER_UNAVAILABLE");
    assert.equal(failed.start_worktree_path, join(f.directory, "repo-workitem-one"));
    assert.equal(failed.current_session_id, null);
    assert.doesNotMatch(failed.start_error, /super-secret/);
    const operation = f.store.selectOne("SELECT * FROM work_item_start_operations WHERE work_item_id=?", [f.workItem.id]);
    assert.equal(operation.stage, "failed");
    assert.equal(operation.failure_stage, "creatingSession");
    assert.equal(operation.worktree_branch, "workitem/one");
    assert.equal(f.audits.at(-1).metadata.failed, true);
    assert.doesNotMatch(JSON.stringify(f.audits.at(-1)), /super-secret/);
  } finally {
    await cleanup(f);
  }
});

test("binding failure keeps the created Session and retry reuses both Session and Worktree", async () => {
  const f = await fixture();
  try {
    let failBinding = true;
    f.service.finalizeStart = (input) => {
      f.calls.finalize += 1;
      if (failBinding) {
        failBinding = false;
        const error = new Error("binding transaction unavailable");
        error.code = "BINDING_FAILED";
        throw error;
      }
      return f.store.finalizeWorkItemStart(input);
    };
    await assert.rejects(() => f.service.start(startInput()), { code: "BINDING_FAILED" });
    assert.equal(f.store.getWorkItem(f.workItem.id).start_failure_stage, "binding");
    const firstSessionId = f.store.selectOne(
      "SELECT session_id FROM work_item_start_operations WHERE work_item_id=?", [f.workItem.id]
    ).session_id;
    const retried = await f.service.start(startInput());
    assert.equal(retried.phase, "running");
    assert.equal(retried.session.id, firstSessionId);
    assert.equal(f.calls.create, 1, "retry must not create a duplicate Provider Session");
    assert.equal(f.calls.workspace, 2, "retry revalidates and safely reuses the Worktree");
    assert.equal(retried.workspace.path, join(f.directory, "repo-workitem-one"));
  } finally {
    await cleanup(f);
  }
});

test("binding finalization preserves a Provider-created Worker Session's complete entity ownership", async () => {
  const f = await fixture();
  try {
    f.service.createSession = async ({ providerId, workspace }) => {
      f.calls.create += 1;
      const id = "provider:worker:missing-ownership";
      f.store.createSession({
        id,
        title: f.workItem.title,
        provider: providerId,
        agentId: f.agent.agentId,
        sessionKind: "worker",
        objectiveId: f.objective.id,
        workItemId: f.workItem.id,
        cwd: workspace.path
      });
      f.store.createLogicalSessionRoute({
        logicalSessionId: "session:worker:missing-ownership",
        legacySessionId: id,
        providerThreadId: "thread:missing-ownership",
        providerSessionId: id,
        providerId,
        boundCwd: workspace.path,
        sessionName: "Missing ownership"
      });
      f.core.bindSession({ agentId: f.agent.agentId, sessionId: id });
      return f.store.getSession(id);
    };

    const result = await f.service.start(startInput());

    assert.equal(result.phase, "running");
    assert.equal(result.session.objectiveId, f.objective.id);
    assert.equal(result.session.workItemId, f.workItem.id);
    assert.equal(result.workItem.current_session_id, result.session.id);
    assert.equal(f.calls.activate, 1, "initial work activates only after ownership is finalized");
  } finally {
    await cleanup(f);
  }
});

test("self-repair replaces exactly the currently bound abnormal Session", async () => {
  const f = await fixture();
  try {
    const first = await f.service.start(startInput());
    const replacement = await f.service.start({
      ...startInput(),
      idempotencyKey: `self-repair:${f.workItem.id}:${first.session.id}`,
      source: "self-repair",
      replacingSessionId: first.session.id
    });

    assert.notEqual(replacement.session.id, first.session.id);
    assert.equal(replacement.workItem.current_session_id, replacement.session.id);
    assert.equal(f.calls.create, 2);
    assert.deepEqual(f.store.listUnusableReplacedWorkItemSessionIds(), [first.session.id]);

    const staleRepair = await f.service.start({
      ...startInput(),
      idempotencyKey: "self-repair:stale",
      source: "self-repair",
      replacingSessionId: first.session.id
    });
    assert.equal(staleRepair.session.id, replacement.session.id);
    assert.equal(staleRepair.idempotentReplay, true);
    assert.equal(f.calls.create, 2, "a stale repair proof cannot replace the newer Session");
  } finally {
    await cleanup(f);
  }
});

test("Provider validation fails before Worktree preparation and uses a stable code", async () => {
  const f = await fixture();
  try {
    f.service.validateStart = async () => {
      const error = new Error("Provider bridge is unavailable");
      error.code = "PROVIDER_UNAVAILABLE";
      throw error;
    };
    await assert.rejects(() => f.service.start(startInput("openclacky")), { code: "PROVIDER_UNAVAILABLE" });
    assert.equal(f.calls.workspace, 0);
    assert.equal(f.store.getWorkItem(f.workItem.id).start_failure_stage, "validating");
  } finally {
    await cleanup(f);
  }
});

test("Workspace failure creates neither Session nor false running state", async () => {
  const f = await fixture();
  try {
    f.service.prepareWorkspace = async () => {
      f.calls.workspace += 1;
      const error = new Error("main Worktree unavailable");
      error.code = "WORKSPACE_UNAVAILABLE";
      throw error;
    };
    await assert.rejects(() => f.service.start(startInput()), { code: "WORKSPACE_UNAVAILABLE" });
    const failed = f.store.getWorkItem(f.workItem.id);
    assert.equal(failed.start_failure_stage, "preparingWorkspace");
    assert.equal(failed.current_session_id, null);
    assert.equal(f.calls.create, 0);
  } finally {
    await cleanup(f);
  }
});

test("same Agent keeps Objective Chat and Worker bindings while currentSessionId advances by recency", async () => {
  const f = await fixture();
  try {
    f.store.createSession({
      id: "provider:objective-chat", title: "Objective Chat", agentId: f.agent.agentId,
      sessionKind: "objectiveChat", objectiveId: f.objective.id
    });
    f.store.createLogicalSessionRoute({
      logicalSessionId: "session:objective-chat", legacySessionId: "provider:objective-chat",
      providerThreadId: "thread:objective-chat", providerSessionId: "provider:objective-chat",
      providerId: "codex-app-server", boundCwd: f.directory, sessionName: "Objective Chat"
    });
    f.core.bindSession({ agentId: f.agent.agentId, sessionId: "provider:objective-chat" });
    const result = await f.service.start(startInput("claude-sdk"));
    const active = f.store.selectAll(
      "SELECT session_id FROM agent_sessions WHERE agent_id=? AND unbound_at IS NULL ORDER BY bound_at",
      [f.agent.agentId]
    ).map((row) => row.session_id);
    assert.deepEqual(new Set(active), new Set(["provider:objective-chat", result.session.id]));
    assert.equal(f.store.getAgent(f.agent.agentId).currentSessionId, result.session.id);
    assert.equal(f.store.getSession("provider:objective-chat").sessionKind, "objectiveChat");
  } finally {
    await cleanup(f);
  }
});

test("interrupted persisted start becomes observable after an actual Store restart", async () => {
  const f = await fixture();
  try {
    const timestamp = new Date().toISOString();
    f.store.db.run(
      `INSERT INTO work_item_start_operations (
        operation_id, work_item_id, objective_id, agent_id, provider_id, idempotency_key,
        input_fingerprint, source, status, stage, created_at, updated_at
      ) VALUES ('work_item_start:interrupted', ?, ?, ?, 'codex-app-server', 'start:stable', ?,
        'test', 'in_progress', 'creatingSession', ?, ?)`,
      [f.workItem.id, f.objective.id, f.agent.agentId,
        // Match the production fingerprint generated by the service.
        "placeholder", timestamp, timestamp]
    );
    f.store.db.run(
      "UPDATE work_items SET execution_status='starting', start_stage='creatingSession', start_idempotency_key='start:stable' WHERE id=?",
      [f.workItem.id]
    );
    await f.store.close();
    f.store = new CorptieStore({
      dbPath: join(f.directory, "db.sqlite"),
      configPath: join(f.directory, "config.json")
    });
    await f.store.initialize();
    f.service = new WorkItemStartService({
      store: f.store,
      validateStart: async () => { throw new Error("not called during recovery"); },
      prepareWorkspace: async () => { throw new Error("not called during recovery"); },
      createSession: async () => { throw new Error("not called during recovery"); },
      finalizeStart: async () => { throw new Error("not called during recovery"); }
    });
    assert.equal(f.service.recoverInterruptedStarts(), 1);
    const failed = f.store.getWorkItem(f.workItem.id);
    assert.equal(failed.start_error_code, "START_INTERRUPTED");
    assert.equal(failed.start_failure_stage, "creatingSession");
  } finally {
    await cleanup(f);
  }
});

test("duplicate concurrent retries share one Provider Session creation", async () => {
  const f = await fixture();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    f.service.createSession = async (input) => {
      await gate;
      return f.createWorkerSession(input);
    };
    const first = f.service.start(startInput());
    const second = f.service.start(startInput());
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.session.id, two.session.id);
    assert.equal(f.calls.create, 1);
    assert.equal(f.audits.filter(({ entry }) => entry.event === "work_item_start_requested").length, 1);
    assert.equal(f.audits.filter(({ entry }) => entry.event === "work_item_start_retried").length, 0);
  } finally {
    await cleanup(f);
  }
});

test("legacy existing-Worktree/no-Session shape is detected without deleting or modifying the Worktree", async () => {
  const f = await fixture();
  try {
    const repositoryId = "repository:legacy";
    const worktreePath = join(f.directory, "repo-workitem-one");
    f.store.db.run(
      `INSERT INTO git_repositories (repository_id, common_git_dir, discovered_at, last_validated_at)
       VALUES (?, ?, ?, ?)`,
      [repositoryId, join(f.directory, ".git"), new Date().toISOString(), new Date().toISOString()]
    );
    f.store.db.run(
      `INSERT INTO git_worktrees (worktree_id, repository_id, path, canonical_path, git_dir, is_main,
       availability, branch_name, detached, locked, prunable, inventory_version, observed_at, raw_json)
       VALUES ('worktree:legacy', ?, ?, ?, ?, 0, 'available', 'workitem/one', 0, 0, 0, 'v1', ?, '{}')`,
      [repositoryId, worktreePath, worktreePath, join(worktreePath, ".git"), new Date().toISOString()]
    );
    f.store.db.run(
      "UPDATE work_items SET main_workspace_id=?, status='done', execution_status='idle', start_stage=NULL, start_error=NULL WHERE id=?",
      [repositoryId, f.workItem.id]
    );
    assert.equal(f.service.detectLegacyPartialStarts(), 0, "completed WorkItems with retained Worktrees are not start remnants");
    f.store.db.run("UPDATE work_items SET status='todo' WHERE id=?", [f.workItem.id]);
    assert.equal(f.service.detectLegacyPartialStarts(), 1);
    const detected = f.store.getWorkItem(f.workItem.id);
    assert.equal(detected.start_error_code, "LEGACY_PARTIAL_START_DETECTED");
    assert.equal(detected.start_failure_stage, "creatingSession");
    assert.equal(detected.start_worktree_path, worktreePath);
    assert.equal(detected.current_session_id, null);
  } finally {
    await cleanup(f);
  }
});

test("Codex, Claude, and OpenClacky use the same shared stage contract", async () => {
  for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
    const f = await fixture();
    try {
      const result = await f.service.start(startInput(providerId));
      assert.equal(result.providerBinding.providerId, providerId);
      assert.equal(f.store.getWorkItem(f.workItem.id).start_stage, "running");
    } finally {
      await cleanup(f);
    }
  }
});

test("safe cancellation preserves recorded Worktree metadata", async () => {
  const f = await fixture();
  try {
    f.service.createSession = async () => { throw Object.assign(new Error("down"), { code: "PROVIDER_UNAVAILABLE" }); };
    await assert.rejects(() => f.service.start(startInput()));
    const path = f.store.getWorkItem(f.workItem.id).start_worktree_path;
    const canceled = f.service.cancel(f.workItem.id, "User chose another task");
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.execution_status, "cancelled");
    assert.equal(canceled.start_worktree_path, path);
  } finally {
    await cleanup(f);
  }
});
