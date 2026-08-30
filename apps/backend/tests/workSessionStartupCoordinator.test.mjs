import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkSessionStartupCoordinator,
  startupContextHash
} from "../src/application/workSessionStartupCoordinator.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-authoritative-startup-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const core = new CollaborationCore(store);
  const objectiveService = new ObjectiveApplicationService({ store });
  const agent = store.createAgent({ id: "agent:worker", name: "Worker", role: "independentContributor" });
  const worktreePath = join(directory, "worktrees", "one");
  const now = new Date().toISOString();
  store.db.run(
    "INSERT INTO git_repositories (repository_id, common_git_dir, discovered_at, last_validated_at) VALUES (?, ?, ?, ?)",
    ["repository:one", join(directory, "repo", ".git"), now, now]
  );
  store.db.run(
    `INSERT INTO git_worktrees (worktree_id, repository_id, path, canonical_path, git_dir, is_main,
      availability, head_oid, branch_ref, branch_name, detached, inventory_version, observed_at, raw_json)
     VALUES ('worktree:one', 'repository:one', ?, ?, ?, 0, 'available', ?,
      'refs/heads/workitem/one', 'workitem/one', 0, 'inventory:one', ?, '{}')`,
    [worktreePath, worktreePath, join(directory, "repo", ".git", "worktrees", "one"), COMMIT, now]
  );
  const objective = objectiveService.createObjective({
    id: "objective:one", name: "Objective", contributorAgentIds: [agent.agentId],
    workspaceIds: ["repository:one"]
  });
  const workItem = objectiveService.createWorkItem({
    id: "work_item:one", objectiveId: objective.id, title: "Authoritative startup",
    mainAgentId: agent.agentId, mainWorkspaceId: "repository:one"
  });
  const calls = { prepare: 0, inspectWorktree: 0, create: 0, bind: 0, inspectBinding: 0, activate: 0, compensate: 0 };
  const allocation = {
    repositoryId: "repository:one", worktreeId: "worktree:one",
    canonicalWorktreePath: worktreePath,
    headIdentity: { kind: "branch", branch: "workitem/one" },
    sourceCommitOid: COMMIT, sourceTreeOid: TREE, baseRef: "main",
    repositoryInventoryVersion: "inventory:one", workspaceResourceVersion: 1,
    createdByStartupOperationId: null, reused: false
  };
  const service = new WorkSessionStartupCoordinator({
    store,
    leaseOwner: overrides.leaseOwner ?? "test-worker",
    validateStart: async (input) => ({
      workItem: store.getWorkItem(input.workItemId), objective, agent, providerId: input.providerId
    }),
    prepareWorktree: async (input) => {
      calls.prepare += 1;
      return { ...allocation, createdByStartupOperationId: input.startupOperationId };
    },
    inspectWorktree: async ({ operation, allocation: candidate }) => {
      calls.inspectWorktree += 1;
      return { ...candidate, createdByStartupOperationId: operation.startup_operation_id };
    },
    createSession: async ({ providerId, workspace }) => {
      calls.create += 1;
      const id = `provider:worker:${calls.create}`;
      store.createSession({
        id, title: workItem.title, provider: providerId, agentId: agent.agentId,
        sessionKind: "worker", objectiveId: objective.id, workItemId: workItem.id,
        cwd: workspace.canonicalWorktreePath
      });
      store.createLogicalSessionRoute({
        logicalSessionId: `session:worker:${calls.create}`, legacySessionId: id,
        providerThreadId: `thread:${calls.create}`, providerSessionId: id,
        providerId, boundCwd: workspace.canonicalWorktreePath, sessionName: workItem.title
      });
      core.bindSession({ agentId: agent.agentId, sessionId: id });
      return store.getSession(id);
    },
    bindProviderWorkspace: async (input) => {
      calls.bind += 1;
      assert.equal(input.trustedContext.providerBindingId, input.providerBindingId);
      assert.equal(input.trustedContext.bindingGeneration, input.bindingGeneration);
      assert.equal(startupContextHash(input.trustedContext), input.trustedContextHash);
      return proof(input, `resource:${calls.bind}`);
    },
    inspectProviderBinding: async () => {
      calls.inspectBinding += 1;
      const error = new Error("not bound"); error.code = "START_PROVIDER_BINDING_NOT_FOUND"; throw error;
    },
    activateSession: async ({ receipt }) => {
      calls.activate += 1;
      assert.equal(store.selectOne(
        "SELECT state FROM work_session_startup_operations WHERE startup_operation_id=?",
        [receipt.startupOperationId]
      ).state, "ready", "first Turn may dispatch only after ready receipt commits");
    },
    compensateWorktree: async () => { calls.compensate += 1; return { removed: true }; },
    ...overrides
  });
  return { directory, store, service, calls, allocation, workItem };
}

function input(key = "start:one") {
  return {
    workItemId: "work_item:one", requestedAgentId: "agent:worker",
    providerId: "codex-app-server", idempotencyKey: key, source: "test"
  };
}

function proof(binding, providerResourceId = "resource:one") {
  return {
    providerBindingId: binding.providerBindingId,
    bindingGeneration: binding.bindingGeneration,
    providerResourceId,
    canonicalWorkingDirectory: binding.workingDirectory,
    trustedContextHash: binding.trustedContextHash,
    acceptedAt: new Date().toISOString()
  };
}

async function cleanup(f) {
  await f.store.close();
  await rm(f.directory, { recursive: true, force: true });
}

test("commits a complete hash-verifiable StartupBindingReceipt before first Turn dispatch", async () => {
  const f = await fixture();
  try {
    const result = await f.service.start(input());
    assert.equal(result.status, "ready");
    assert.equal(result.receipt.schemaVersion, 2);
    assert.equal(result.receipt.status, "ready");
    assert.equal(result.receipt.objectiveId, "objective:one");
    assert.equal(result.receipt.logicalSessionId, "session:worker:1");
    assert.equal(result.receipt.repositoryId, "repository:one");
    assert.equal(result.receipt.worktreeId, "worktree:one");
    assert.equal(result.receipt.sourceCommitOid, COMMIT);
    assert.equal(result.receipt.sourceTreeOid, TREE);
    assert.equal(result.receipt.bindingGeneration, 1);
    assert.equal(f.service.verifyReceipt(result.receipt), true);
    assert.equal(f.calls.activate, 1);
    assert.deepEqual(
      f.store.selectAll("SELECT event FROM work_session_startup_audit ORDER BY created_at, rowid").map((row) => row.event),
      ["startup.allocated", "startup.worktree_prepared", "startup.session_bound", "startup.provider_bound", "startup.ready"]
    );
  } finally { await cleanup(f); }
});

test("Store exposes only the Revision 2 startup authority and no legacy start table", async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.selectOne(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='work_item_start_operations'"
    ), null);
    assert.ok(f.store.selectOne(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='work_session_startup_operations'"
    ));
    const legacyColumns = new Set([
      "start_idempotency_key", "start_error", "start_stage", "start_failure_stage",
      "start_error_code", "start_started_at", "start_stage_updated_at", "start_failed_at",
      "start_provider_id", "start_agent_id", "start_worktree_id", "start_worktree_path",
      "start_worktree_branch"
    ]);
    assert.deepEqual(
      f.store.selectAll("PRAGMA table_info(work_items)")
        .map((column) => column.name)
        .filter((name) => legacyColumns.has(name)),
      []
    );
  } finally { await cleanup(f); }
});

test("prepared-worktree startup coordinator overhead remains below the local 750ms budget", async () => {
  const f = await fixture();
  try {
    const startedAt = performance.now();
    const result = await f.service.start(input());
    const durationMilliseconds = performance.now() - startedAt;
    assert.equal(result.status, "ready");
    assert.ok(durationMilliseconds < 750, `startup took ${durationMilliseconds.toFixed(2)}ms`);
  } finally { await cleanup(f); }
});

test("same idempotency key replays one operation, resource set, and receipt hash", async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([f.service.start(input()), f.service.start(input())]);
    assert.equal(first.receipt.receiptHash, second.receipt.receiptHash);
    assert.equal(f.calls.prepare, 1);
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.bind, 1);
    const replay = await f.service.start(input());
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.receipt.receiptHash, first.receipt.receiptHash);
  } finally { await cleanup(f); }
});

test("different idempotency keys cannot create concurrent startup operations for one WorkItem", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ createSession: async () => gate });
  try {
    const first = f.service.start(input("start:first"));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(async () => f.service.start(input("start:second")), {
      code: "START_ALREADY_IN_PROGRESS"
    });
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM work_session_startup_operations").count, 1);
    const error = new Error("stop first"); error.code = "PROVIDER_UNAVAILABLE";
    release(Promise.reject(error));
    await assert.rejects(() => first, { code: "PROVIDER_UNAVAILABLE" });
  } finally { await cleanup(f); }
});

test("same idempotency key with different Provider input is rejected", async () => {
  const f = await fixture();
  try {
    await f.service.start(input());
    await assert.rejects(async () => f.service.start({ ...input(), providerId: "claude-sdk" }), {
      code: "START_IDEMPOTENCY_CONFLICT"
    });
  } finally { await cleanup(f); }
});

test("inspects an uncertain Provider outcome before binding and reuses the verified proof", async () => {
  let inspections = 0;
  const f = await fixture({
    inspectProviderBinding: async (binding) => {
      inspections += 1;
      return proof(binding, "resource:already-bound");
    },
    bindProviderWorkspace: async () => assert.fail("verified Provider proof must be reused")
  });
  try {
    const result = await f.service.start(input());
    assert.equal(result.status, "ready");
    assert.equal(inspections, 1);
    assert.equal(result.receipt.bindingGeneration, 1);
  } finally { await cleanup(f); }
});

test("a Provider proof mismatch never reports ready and compensates owned resources", async () => {
  const f = await fixture({
    bindProviderWorkspace: async (binding) => ({ ...proof(binding), canonicalWorkingDirectory: join(tmpdir(), "wrong") })
  });
  try {
    await assert.rejects(() => f.service.start(input()), { code: "START_PROVIDER_CWD_MISMATCH" });
    const operation = f.store.selectOne("SELECT * FROM work_session_startup_operations WHERE work_item_id='work_item:one'");
    assert.equal(operation.state, "failed_compensated");
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM work_session_startup_receipts").count, 0);
    assert.equal(f.calls.compensate, 1);
    assert.equal(f.store.getWorkItem("work_item:one").execution_status, "start_failed");
  } finally { await cleanup(f); }
});

test("receipt write failure rolls back ready state atomically", async () => {
  const f = await fixture();
  try {
    f.store.db.run(
      `CREATE TRIGGER fail_startup_receipt BEFORE INSERT ON work_session_startup_receipts
       BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`
    );
    await assert.rejects(() => f.service.start(input()));
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM work_session_startup_receipts").count, 0);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM work_session_startup_bindings WHERE status='ready'").count, 0);
    assert.notEqual(
      f.store.selectOne("SELECT state FROM work_session_startup_operations").state,
      "ready"
    );
    assert.equal(f.calls.activate, 0);
  } finally { await cleanup(f); }
});

test("Store guards reject ready without a matching receipt and immutable binding path changes", async () => {
  const f = await fixture();
  try {
    const ready = await f.service.start(input());
    assert.throws(() => f.store.db.run(
      "UPDATE work_session_startup_bindings SET canonical_worktree_path='/tmp/forged' WHERE provider_binding_id=?",
      [ready.receipt.providerBindingId]
    ), /START_BINDING_PATH_IMMUTABLE/);

    f.store.db.run("DELETE FROM work_session_startup_receipts WHERE startup_operation_id=?", [ready.receipt.startupOperationId]);
    f.store.db.run(
      "UPDATE work_session_startup_operations SET state='provider_bound', ready_at=NULL WHERE startup_operation_id=?",
      [ready.receipt.startupOperationId]
    );
    assert.throws(() => f.store.db.run(
      "UPDATE work_session_startup_operations SET state='ready', ready_at=? WHERE startup_operation_id=?",
      [new Date().toISOString(), ready.receipt.startupOperationId]
    ), /START_RECEIPT_REQUIRED/);
  } finally { await cleanup(f); }
});

test("dirty owned Worktree produces manual-required compensation and no ready state", async () => {
  const f = await fixture({
    createSession: async () => { const error = new Error("provider failed"); error.code = "PROVIDER_UNAVAILABLE"; throw error; },
    compensateWorktree: async () => ({ removed: false, dirty: true, manualRequired: true })
  });
  try {
    await assert.rejects(() => f.service.start(input()), { code: "PROVIDER_UNAVAILABLE" });
    const failed = f.service.getReceipt({
      startupOperationId: f.store.selectOne("SELECT startup_operation_id FROM work_session_startup_operations").startup_operation_id
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.phase, "failed_manual_cleanup");
    assert.equal(failed.error.code, "START_COMPENSATION_DIRTY_WORKTREE");
    assert.equal(failed.compensation.status, "manual_required");
  } finally { await cleanup(f); }
});

test("stale Provider callback is audited and cannot overwrite the current generation", async () => {
  const f = await fixture();
  try {
    const ready = await f.service.start(input());
    f.store.db.run("UPDATE work_session_startup_bindings SET binding_generation=2 WHERE provider_binding_id=?", [ready.receipt.providerBindingId]);
    f.store.db.run("UPDATE work_session_startup_operations SET binding_generation=2 WHERE startup_operation_id=?", [ready.receipt.startupOperationId]);
    const result = f.service.acceptProviderProof({
      providerBindingId: ready.receipt.providerBindingId,
      bindingGeneration: 1,
      providerResourceId: "late:one",
      canonicalWorkingDirectory: ready.receipt.canonicalWorktreePath,
      trustedContextHash: ready.receipt.providerContextHash
    });
    assert.deepEqual(result, { accepted: false, code: "START_PROVIDER_GENERATION_STALE" });
    assert.equal(
      f.store.selectOne("SELECT provider_resource_id FROM work_session_startup_bindings WHERE provider_binding_id=?", [ready.receipt.providerBindingId]).provider_resource_id,
      "resource:1"
    );
    assert.equal(f.store.selectOne(
      "SELECT COUNT(*) AS count FROM work_session_startup_audit WHERE event='startup.provider_receipt_rejected_stale_generation'"
    ).count, 1);
  } finally { await cleanup(f); }
});

test("future Provider generation is rejected and cannot mutate a ready binding", async () => {
  const f = await fixture();
  try {
    const ready = await f.service.start(input());
    await assert.rejects(async () => f.service.acceptProviderProof({
      providerBindingId: ready.receipt.providerBindingId,
      bindingGeneration: 2,
      providerResourceId: "future:one",
      canonicalWorkingDirectory: ready.receipt.canonicalWorktreePath,
      trustedContextHash: ready.receipt.providerContextHash
    }), { code: "START_PROVIDER_GENERATION_INVALID" });
    assert.equal(
      f.store.selectOne("SELECT provider_resource_id FROM work_session_startup_bindings WHERE provider_binding_id=?", [ready.receipt.providerBindingId]).provider_resource_id,
      "resource:1"
    );
    assert.equal(f.store.selectOne(
      "SELECT COUNT(*) AS count FROM work_session_startup_audit WHERE event='startup.provider_receipt_rejected_future_generation'"
    ).count, 1);
  } finally { await cleanup(f); }
});

test("backend reopen recovers an expired worktree_prepared lease without duplicating the Worktree", async () => {
  const f = await fixture();
  try {
    const operationId = "startup:crashed";
    const now = "2026-08-30T00:00:00.000Z";
    const allocation = { ...f.allocation, createdByStartupOperationId: operationId };
    f.store.db.run(
      `INSERT INTO work_session_startup_operations (
        startup_operation_id, objective_id, work_item_id, requested_agent_id, provider_id,
        repository_id, idempotency_key, request_fingerprint, source, state, worktree_id,
        allocation_json, lease_owner, lease_expires_at, correlation_id, allocated_at,
        worktree_prepared_at, updated_at, resource_version
      ) VALUES (?, 'objective:one', 'work_item:one', 'agent:worker', 'codex-app-server',
        'repository:one', 'start:crashed', 'fingerprint', 'test', 'worktree_prepared',
        'worktree:one', ?, 'dead-process', '2026-08-30T00:00:00.001Z', 'correlation:crash', ?, ?, ?, 2)`,
      [operationId, JSON.stringify(allocation), now, now, now]
    );
    await f.store.close();
    const reopened = new CorptieStore({
      dbPath: join(f.directory, "db.sqlite"), configPath: join(f.directory, "config.json")
    });
    await reopened.initialize();
    f.store = reopened;
    const core = new CollaborationCore(reopened);
    let created = 0;
    const recovered = new WorkSessionStartupCoordinator({
      store: reopened,
      leaseOwner: "recovery-worker",
      clock: () => "2026-08-30T00:01:00.000Z",
      validateStart: async (value) => ({
        workItem: reopened.getWorkItem(value.workItemId),
        objective: reopened.getObjective("objective:one"),
        agent: reopened.getAgent("agent:worker"), providerId: value.providerId
      }),
      prepareWorktree: async () => { throw new Error("must reuse committed allocation"); },
      inspectWorktree: async ({ allocation: value }) => value,
      createSession: async ({ providerId, workspace }) => {
        created += 1;
        reopened.createSession({
          id: "provider:recovered", title: "Recovered", provider: providerId,
          agentId: "agent:worker", sessionKind: "worker", objectiveId: "objective:one",
          workItemId: "work_item:one", cwd: workspace.canonicalWorktreePath
        });
        reopened.createLogicalSessionRoute({
          logicalSessionId: "session:recovered", legacySessionId: "provider:recovered",
          providerThreadId: "thread:recovered", providerSessionId: "provider:recovered",
          providerId, boundCwd: workspace.canonicalWorktreePath, sessionName: "Recovered"
        });
        core.bindSession({ agentId: "agent:worker", sessionId: "provider:recovered" });
        return reopened.getSession("provider:recovered");
      },
      bindProviderWorkspace: async (value) => proof(value, "resource:recovered"),
      inspectProviderBinding: async () => null
    });
    const result = await recovered.recover(operationId);
    assert.equal(result.status, "ready");
    assert.equal(created, 1);
    assert.equal(reopened.selectOne("SELECT COUNT(*) AS count FROM work_session_startup_operations").count, 1);
    assert.equal(reopened.selectOne("SELECT COUNT(*) AS count FROM work_session_startup_receipts").count, 1);
    assert.equal(reopened.selectOne(
      "SELECT COUNT(*) AS count FROM work_session_startup_audit WHERE event='startup.lease_taken_over'"
    ).count, 1);
  } finally { await cleanup(f); }
});
