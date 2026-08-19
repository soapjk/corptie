import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorktreeIntegrationJobService } from "../src/application/worktreeIntegrationJobService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

function memoryFixture({
  conflictOnce = false,
  blockingRisk = false,
  featureAlreadyMerged = false,
  featureDirty = true,
  mainDirty = true
} = {}) {
  const jobs = new Map();
  let sequence = 0;
  const repository = { id: "repository:1", commonGitDirCanonicalPath: "/repo/.git" };
  const worktrees = [
    {
      worktreeId: "wt:main", path: "/repo", isMain: true, availability: "available",
      headOid: "main:1", branchName: "main", dirty: mainDirty,
      statusSummary: mainDirty ? " M main.txt" : "",
      changedFiles: mainDirty ? ["main.txt"] : [],
      aheadOfMain: 0, behindMain: 0, mergedIntoMain: true,
      isLocked: false, isPrunable: false, isDetached: false, operationState: null, conflictFiles: [], sessions: []
    },
    {
      worktreeId: "wt:feature", path: "/repo-feature", isMain: false, availability: "available",
      headOid: "feature:1", branchName: "feature/one", dirty: featureDirty,
      statusSummary: featureDirty ? " M feature.txt" : "",
      changedFiles: featureDirty ? ["feature.txt"] : [],
      aheadOfMain: 1, behindMain: 0, mergedIntoMain: featureAlreadyMerged,
      isLocked: blockingRisk, lockReason: blockingRisk ? "owned by another process" : null,
      isPrunable: false, isDetached: false, operationState: null, conflictFiles: [], sessions: []
    }
  ];
  const store = {
    listGitRepositories: () => [{ id: repository.id, path: "/repo/.git", name: "repo" }],
    getGitRepository: (id) => id === repository.id ? repository : null,
    listGitWorktrees: () => worktrees,
    resolveWorkspacePath: () => "/repo",
    listWorktreeIntegrationJobs: () => [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    getLatestWorktreeIntegrationJob: () => [...jobs.values()].at(-1) ?? null,
    getWorktreeIntegrationJob: (id) => jobs.get(id) ? structuredClone(jobs.get(id)) : null,
    listRecoverableWorktreeIntegrationJobs: () => [...jobs.values()].filter((job) => ["queued", "running"].includes(job.status)),
    createWorktreeIntegrationJob(input) {
      const now = new Date(Date.now() + sequence++).toISOString();
      const job = {
        id: `job:${sequence}`, repositoryId: input.repositoryId, status: input.status ?? "awaiting_confirmation",
        phase: input.phase ?? "preflight_complete", planFingerprint: input.planFingerprint,
        details: input.details, error: null, createdAt: now, updatedAt: now, confirmedAt: null, completedAt: null
      };
      jobs.set(job.id, job);
      return structuredClone(job);
    },
    updateWorktreeIntegrationJob(id, patch) {
      Object.assign(jobs.get(id), patch, { updatedAt: new Date(Date.now() + sequence++).toISOString() });
      return structuredClone(jobs.get(id));
    },
    getSession: (id) => id === "session:conflict" ? { id, status: "complete" } : null,
    getWorkItem: () => null
  };
  const calls = [];
  let shouldConflict = conflictOnce;
  const service = new WorktreeIntegrationJobService({
    store,
    inspectRepository: async () => ({
      repositoryId: repository.id, inventoryVersion: "inventory:1", mainWorktreeId: "wt:main",
      mainPath: "/repo", mainHeadOid: worktrees[0].headOid, worktrees: structuredClone(worktrees)
    }),
    commitChanges: async (input) => {
      calls.push(`commit:${input.path}`);
      const worktree = worktrees.find((entry) => entry.path === input.path);
      worktree.headOid = `${worktree.headOid}:commit`;
      worktree.dirty = false;
      worktree.statusSummary = "";
      return { committed: true, recovered: false, headOid: worktree.headOid };
    },
    mergeSource: async (input) => {
      calls.push(`merge:${input.sourceHead}`);
      if (shouldConflict) {
        shouldConflict = false;
        const error = new Error("Resolve the conflict");
        error.code = "MERGE_CONFLICT";
        error.conflictFiles = ["shared.txt"];
        throw error;
      }
      worktrees[0].headOid = `${input.expectedMainHead}:merge`;
      worktrees[1].mergedIntoMain = true;
      return { merged: true, alreadyMerged: false, recovered: conflictOnce, mainHead: worktrees[0].headOid };
    },
    prepareConflictResolution: async (input) => {
      calls.push(`prepare-conflict:${input.sourceHead}`);
      return {
        worktreeId: "wt:integration", path: "/repo-integration", branchName: "integration/job-1",
        headOid: input.expectedMainHead
      };
    },
    launchConflictResolution: async (input) => {
      calls.push(`launch-agent:${input.item.worktreeId}`);
      return {
        workItemId: "work_item:conflict", sessionId: "session:conflict",
        agentId: "agent:one", agentName: "Conflict Agent"
      };
    }
  });
  return { service, store, calls };
}

async function waitForJob(service, id, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.get(id);
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`job ${id} did not reach ${status}`);
}

test("reviewed plan commits main and every dirty Worktree separately before deterministic merge", async () => {
  const { service, calls } = memoryFixture();
  const plan = await service.preflight("repository:1");
  assert.deepEqual(plan.plan.items.map((item) => item.worktreeId), ["wt:main", "wt:feature"]);
  assert.deepEqual(plan.plan.mergeOrder, ["wt:feature"]);
  assert.equal(plan.status, "awaiting_confirmation");
  assert.throws(() => service.confirm(plan.id, { confirmed: true, planFingerprint: "wrong" }), {
    code: "EXPLICIT_CONFIRMATION_REQUIRED"
  });

  service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const completed = await waitForJob(service, plan.id, "completed");
  assert.deepEqual(calls, ["commit:/repo", "commit:/repo-feature", "merge:feature:1:commit"]);
  assert.equal(completed.progress.fraction, 1);
  assert.equal(completed.plan.items[1].mergeStatus, "completed");
  assert.ok(completed.audit.some((entry) => entry.event === "plan_confirmed"));
  assert.ok(completed.audit.some((entry) => entry.event === "execution_completed"));
});

test("an awaiting-confirmation plan prevents duplicate preflight jobs", async () => {
  const { service } = memoryFixture();
  const plan = await service.preflight("repository:1");

  await assert.rejects(() => service.preflight("repository:1"), {
    code: "INTEGRATION_JOB_ACTIVE"
  });
  assert.equal(service.get(plan.id).id, plan.id);
});

test("a stale review can be canceled with an audit record before creating a fresh preflight", async () => {
  const { service } = memoryFixture();
  const stale = await service.preflight("repository:1");
  const canceled = service.cancel(stale.id);

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.phase, "canceled");
  assert.ok(canceled.completedAt);
  assert.equal(canceled.audit.at(-1).event, "plan_canceled");
  const fresh = await service.preflight("repository:1");
  assert.equal(fresh.status, "awaiting_confirmation");
  assert.notEqual(fresh.id, stale.id);
});

test("merge conflict preserves a paused item and retry resumes the same idempotent task", async () => {
  const { service } = memoryFixture({ conflictOnce: true });
  const plan = await service.preflight("repository:1");
  service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForJob(service, plan.id, "paused");
  assert.equal(paused.phase, "conflict");
  assert.equal(paused.plan.items[1].mergeStatus, "conflict");
  assert.deepEqual(paused.plan.items[1].conflictFiles, ["shared.txt"]);

  service.retry(plan.id);
  const completed = await waitForJob(service, plan.id, "completed");
  assert.equal(completed.plan.items[1].mergeStatus, "recovered");
  assert.equal(completed.plan.items[0].commitStatus, "completed");
});

test("a paused merge conflict can launch an Agent in a dedicated Integration Worktree", async () => {
  const { service, calls } = memoryFixture({ conflictOnce: true });
  const plan = await service.preflight("repository:1");
  service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForJob(service, plan.id, "paused");

  const delegated = await service.resolveConflictWithAgent(paused.id);

  assert.equal(delegated.status, "paused");
  assert.equal(delegated.phase, "conflict_resolution_running");
  assert.equal(delegated.conflictResolution.workspace.path, "/repo-integration");
  assert.equal(delegated.conflictResolution.sessionId, "session:conflict");
  assert.equal(delegated.conflictResolution.agentName, "Conflict Agent");
  assert.deepEqual(calls.slice(-2), [
    "prepare-conflict:feature:1:commit",
    "launch-agent:wt:feature"
  ]);
  assert.ok(delegated.audit.some((entry) => entry.event === "conflict_workspace_created"));
  assert.ok(delegated.audit.some((entry) => entry.event === "conflict_agent_started"));
  const ready = service.get(paused.id);
  assert.equal(ready.phase, "conflict_resolution_ready");
  assert.equal(ready.conflictResolution.status, "ready");
  assert.ok(ready.audit.some((entry) => entry.event === "conflict_agent_completed"));
});

test("blocking preflight risks cannot be confirmed", async () => {
  const { service } = memoryFixture({ blockingRisk: true });
  const plan = await service.preflight("repository:1");
  assert.equal(plan.plan.blockingRisks[0].code, "WORKTREE_LOCKED");
  assert.throws(
    () => service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint }),
    { code: "PREFLIGHT_RISKS_UNRESOLVED" }
  );
});

test("a dirty branch still has a merge step when its pre-commit HEAD is already in main", async () => {
  const { service } = memoryFixture({ featureAlreadyMerged: true });
  const plan = await service.preflight("repository:1");
  assert.deepEqual(plan.plan.mergeOrder, ["wt:feature"]);
  assert.equal(plan.plan.items[1].mergeStatus, "pending");
});

test("preflight omits clean Worktrees whose HEAD is already integrated into main", async () => {
  const { service } = memoryFixture({ featureAlreadyMerged: true, featureDirty: false });
  const plan = await service.preflight("repository:1");

  assert.deepEqual(plan.plan.items.map((item) => item.worktreeId), ["wt:main"]);
  assert.deepEqual(plan.plan.mergeOrder, []);
  assert.equal(plan.plan.items.some((item) => item.mergeStatus === "not_needed" && !item.isMain), false);
});

test("preflight completes immediately when every Worktree is already integrated and clean", async () => {
  const { service } = memoryFixture({
    mainDirty: false,
    featureAlreadyMerged: true,
    featureDirty: false
  });
  const plan = await service.preflight("repository:1");

  assert.equal(plan.status, "completed");
  assert.equal(plan.phase, "completed");
  assert.deepEqual(plan.plan.items, []);
  assert.equal(plan.progress.fraction, 1);
  assert.ok(plan.completedAt);
  assert.equal(plan.audit[0].event, "preflight_no_changes");
});

test("integration job, per-item state, and audit survive Store restart", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-worktree-job-"));
  const dbPath = join(directory, "corptie.sqlite");
  let store = new CorptieStore({ dbPath });
  try {
    await store.initialize();
    store.upsertGitWorkspaceSnapshot({
      observedAt: "2026-08-19T00:00:00.000Z", inventoryVersion: "inventory:1",
      repository: {
        id: "repository:1", commonGitDirCanonicalPath: "/repo/.git",
        discoveredAt: "2026-08-19T00:00:00.000Z", lastValidatedAt: "2026-08-19T00:00:00.000Z"
      },
      worktrees: []
    });
    const created = store.createWorktreeIntegrationJob({
      repositoryId: "repository:1", planFingerprint: "fingerprint",
      details: { plan: { items: [{ worktreeId: "wt:1", mergeStatus: "conflict" }] }, audit: [{ event: "paused" }] }
    });
    store.updateWorktreeIntegrationJob(created.id, { status: "queued", phase: "recovery_queued" });
    await store.close();

    store = new CorptieStore({ dbPath });
    await store.initialize();
    const recovered = store.listRecoverableWorktreeIntegrationJobs();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].details.plan.items[0].mergeStatus, "conflict");
    assert.deepEqual(recovered[0].details.audit, [{ event: "paused" }]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
