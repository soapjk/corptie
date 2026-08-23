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
  featureConflict = false,
  mainDirty = false,
  externalConflictResolved = false,
  commitGate = null,
  conflictAttempts = null,
  inspectRepositorySummary = null,
  resolutionInspectionError = null,
  abortMergeError = null,
  conflictSessionStatus = "complete",
  protectedPaths = [],
  activeFeatureSession = false,
  prepareConflictErrors = [],
  launchConflictErrors = [],
  commitErrors = []
} = {}) {
  const jobs = new Map();
  let sequence = 0;
  const repository = { id: "repository:1", commonGitDirCanonicalPath: "/repo/.git" };
  const workItems = new Map();
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
      isPrunable: false, isDetached: false, operationState: featureConflict ? "merge" : null,
      conflictFiles: featureConflict ? ["shared.txt"] : [], sessions: activeFeatureSession ? [{
        logicalSessionId: "logical:active", sessionId: "session:active", title: "Active Agent", active: true
      }] : []
    }
  ];
  if ((conflictAttempts?.length ?? 0) > 1) {
    worktrees.push({
      worktreeId: "wt:feature-two", path: "/repo-feature-two", isMain: false, availability: "available",
      headOid: "feature:2", branchName: "feature/two", dirty: false,
      statusSummary: "", changedFiles: [], aheadOfMain: 1, behindMain: 0, mergedIntoMain: false,
      isLocked: false, isPrunable: false, isDetached: false, operationState: null, conflictFiles: [], sessions: []
    });
  }
  const store = {
    listGitRepositories: () => [{ id: repository.id, path: "/repo/.git", name: "repo" }],
    getGitRepository: (id) => id === repository.id ? repository : null,
    listGitWorktrees: () => worktrees,
    resolveWorkspacePath: () => "/repo",
    listWorktreeIntegrationJobs: () => [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    getLatestWorktreeIntegrationJob: () => [...jobs.values()].at(-1) ?? null,
    getWorktreeIntegrationJob: (id) => jobs.get(id) ? structuredClone(jobs.get(id)) : null,
    listRecoverableWorktreeIntegrationJobs: () => [...jobs.values()].filter((job) =>
      ["queued", "running", "cancellation_requested", "replanning"].includes(job.status)),
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
    getSession: (id) => id?.startsWith("session:conflict")
      ? { id, status: conflictSessionStatus }
      : (id === "session:active" ? { id, status: "running" } : null),
    getWorkItem: (id) => workItems.get(id) ?? null
  };
  const calls = [];
  const removalInputs = [];
  const deletionFailures = [];
  const remainingConflicts = conflictAttempts
    ? [...conflictAttempts]
    : [conflictOnce ? 1 : 0];
  const configuredConflicts = [...remainingConflicts];
  let launchedSession = 0;
  const service = new WorktreeIntegrationJobService({
    store,
    inspectRepositorySummary,
    inspectGitHubPushStatus: async ({ workingDirectory }) => ({
      available: true,
      pending: workingDirectory !== "/repo",
      dirty: false,
      unpushedCommitCount: workingDirectory === "/repo" ? 0 : 1,
      branch: workingDirectory === "/repo" ? "main" : "feature/one",
      destinationUrl: "https://github.com/example/repository",
      error: null
    }),
    inspectRepository: async () => ({
      repositoryId: repository.id, inventoryVersion: "inventory:1", mainWorktreeId: "wt:main",
      mainPath: "/repo", mainHeadOid: worktrees[0].headOid, worktrees: structuredClone(worktrees)
    }),
    inspectCommitProtection: async (path) => ({
      repositoryRoot: path,
      protectedPaths: path === "/repo-feature" ? protectedPaths : [],
      localSymlinkPaths: [],
      suggestedIgnorePatterns: protectedPaths.map((entry) => `/${entry}`),
      warningEnabled: true,
      requiresDecision: path === "/repo-feature" && protectedPaths.length > 0
    }),
    isSessionActive: (session) => session.status === "running",
    commitChanges: async (input) => {
      calls.push(`commit:${input.path}`);
      const commitError = commitErrors.shift();
      if (commitError) throw commitError;
      if (input.protectionDecision) {
        calls.push(`protect:${input.path}:${input.protectionDecision}:${input.neverRemindPrivateFiles === true}`);
      }
      if (commitGate) await commitGate;
      const worktree = worktrees.find((entry) => entry.path === input.path);
      worktree.headOid = `${worktree.headOid}:commit`;
      worktree.dirty = false;
      worktree.statusSummary = "";
      return { committed: true, recovered: false, headOid: worktree.headOid };
    },
    mergeSource: async (input) => {
      calls.push(`merge:${input.sourceHead}`);
      const worktreeIndex = worktrees.findIndex((entry) => !entry.isMain && input.sourceHead.includes(entry.headOid));
      const featureIndex = worktreeIndex - 1;
      if (!input.sourceHead.startsWith("integration:") && remainingConflicts[featureIndex] > 0) {
        remainingConflicts[featureIndex] -= 1;
        const error = new Error("Resolve the conflict");
        error.code = "MERGE_CONFLICT";
        error.conflictFiles = ["shared.txt"];
        throw error;
      }
      worktrees[0].headOid = `${input.expectedMainHead}:merge`;
      worktrees[worktreeIndex].mergedIntoMain = true;
      return {
        merged: true,
        alreadyMerged: false,
        recovered: configuredConflicts[featureIndex] > 0,
        mainHead: worktrees[0].headOid
      };
    },
    abortMerge: async (input) => {
      calls.push(`abort-merge:${input.sourceHead}`);
      if (abortMergeError) throw abortMergeError;
      return { aborted: true, alreadyClean: false, mainHead: input.expectedMainHead };
    },
    prepareConflictResolution: async (input) => {
      calls.push(`prepare-conflict:${input.sourceHead}`);
      const prepareError = prepareConflictErrors.shift();
      if (prepareError) throw prepareError;
      if (externalConflictResolved) {
        worktrees[0].headOid = `${input.expectedMainHead}:external-merge`;
        worktrees[1].mergedIntoMain = true;
        return { alreadyResolved: true, mainHead: worktrees[0].headOid };
      }
      return {
        worktreeId: "wt:integration", path: "/repo-integration", branchName: "integration/job-1",
        headOid: input.expectedMainHead
      };
    },
    inspectConflictResolution: async (input) => {
      calls.push(`inspect-resolution:${input.workspace.path}`);
      if (resolutionInspectionError) throw resolutionInspectionError;
      return {
        resolvedHead: `integration:${input.sourceHead}`,
        mainHead: input.expectedMainHead,
        workspaceId: input.workspace.worktreeId,
        workspacePath: input.workspace.path,
        branchName: input.workspace.branchName
      };
    },
    launchConflictResolution: async (input) => {
      calls.push(`launch-agent:${input.item.worktreeId}`);
      const launchError = launchConflictErrors.shift();
      if (launchError) throw launchError;
      launchedSession += 1;
      return {
        workItemId: `work_item:conflict:${launchedSession}`,
        sessionId: launchedSession === 1 ? "session:conflict" : `session:conflict:${launchedSession}`,
        sessionName: launchedSession === 1 ? "Resolve conflicts" : `Resolve conflicts ${launchedSession}`,
        agentId: "agent:one", agentName: "Conflict Agent"
      };
    },
    removeWorktree: async (input) => {
      removalInputs.push(structuredClone(input));
      calls.push(`remove:${input.worktreeId}`);
      const index = worktrees.findIndex((entry) => entry.worktreeId === input.worktreeId);
      if (index >= 0) worktrees.splice(index, 1);
      return { removed: true, branchDeleted: true };
    },
    onDeletionFailure: (failure) => deletionFailures.push(structuredClone(failure))
  });
  return { service, store, calls, worktrees, workItems, removalInputs, deletionFailures };
}

test("repository listing uses the lightweight summary while preflight keeps the deep inspection", async () => {
  let summaryCalls = 0;
  const summaryWorktrees = [{
    worktreeId: "wt:summary", path: "/repo-summary", isMain: true,
    availability: "available", headOid: "summary:1", branchName: "main",
    dirty: false, statusSummary: "", changedFiles: [], aheadOfMain: 0,
    behindMain: 0, mergedIntoMain: true, synchronizedWithMain: true,
    pendingIntegration: false, isLocked: false, isPrunable: false,
    isDetached: false, operationState: null, conflictFiles: [], sessions: []
  }];
  const { service } = memoryFixture({
    inspectRepositorySummary: async () => {
      summaryCalls += 1;
      return {
        repositoryId: "repository:1", inventoryVersion: "inventory:summary",
        mainWorktreeId: "wt:summary", mainPath: "/repo-summary",
        mainHeadOid: "summary:1", worktrees: structuredClone(summaryWorktrees)
      };
    }
  });

  const listed = await service.repository("repository:1");
  assert.equal(summaryCalls, 1);
  assert.deepEqual(listed.project.worktrees.map((worktree) => worktree.worktreeId), ["wt:summary"]);
  assert.equal(listed.project.worktrees[0].gitHubPush.available, true);
  assert.equal(listed.project.worktrees[0].gitHubPush.pending, true);

  const plan = await service.preflight("repository:1");
  assert.equal(summaryCalls, 1);
  assert.deepEqual(plan.plan.items.map((item) => item.worktreeId), ["wt:main", "wt:feature"]);
});

async function waitForJob(service, id, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.get(id);
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`job ${id} did not reach ${status}`);
}

async function waitForJobWhere(service, id, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.get(id);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`job ${id} did not reach the expected state`);
}

test("repository summary counts only currently available Worktrees", () => {
  const { service, worktrees } = memoryFixture();
  worktrees.push({
    worktreeId: "wt:historical", path: "/repo-removed", isMain: false, availability: "missing"
  });

  const [repository] = service.repositories();

  assert.equal(repository.worktreeCount, 2);
  assert.equal(repository.mainPath, "/repo");
  assert.equal(repository.availability, "available");
});

test("completed WorkItem bindings stop occupying a Worktree after their Session settles", async () => {
  const { service, calls, worktrees, workItems, removalInputs } = memoryFixture({
    mainDirty: false,
    featureAlreadyMerged: true,
    featureDirty: false
  });
  workItems.set("work_item:done", { id: "work_item:done", title: "Finished", status: "done" });
  worktrees[1].sessions = [{
    logicalSessionId: "logical:done", sessionId: null, active: false, workItemId: "work_item:done"
  }];

  const detail = await service.repository("repository:1");
  assert.deepEqual(detail.project.worktrees[1].associations, []);
  assert.equal(detail.project.worktrees[1].deletionBlocker, null);

  const result = await service.deleteWorktree("repository:1", "wt:feature");
  assert.equal(result.status, "removed");
  assert.deepEqual(calls, ["remove:wt:feature"]);
  assert.deepEqual(removalInputs[0].ignoreLogicalSessionIds, ["logical:done"]);
});

test("a running Session still blocks deletion after its WorkItem completes", async () => {
  const { service, calls, worktrees, workItems } = memoryFixture({
    mainDirty: false,
    featureAlreadyMerged: true,
    featureDirty: false
  });
  workItems.set("work_item:done", { id: "work_item:done", title: "Finished", status: "completed" });
  worktrees[1].sessions = [{
    logicalSessionId: "logical:done", sessionId: null, active: true, workItemId: "work_item:done"
  }];

  const detail = await service.repository("repository:1");
  assert.deepEqual(detail.project.worktrees[1].associations.map((entry) => entry.workItemId), [null]);
  await assert.rejects(() => service.deleteWorktree("repository:1", "wt:feature"), {
    code: "WORKTREE_IN_USE"
  });
  assert.deepEqual(calls, []);
});

test("detail and deletion share effective WorkItem associations and report an actionable failure", async () => {
  const { service, calls, worktrees, workItems, deletionFailures } = memoryFixture({
    mainDirty: false,
    featureAlreadyMerged: true,
    featureDirty: false
  });
  workItems.set("work_item:active", {
    id: "work_item:active", title: "Repair workspace routing", status: "in_progress"
  });
  worktrees[1].sessions = [{
    logicalSessionId: "logical:active-work-item", sessionId: null, active: false,
    workItemId: "work_item:active"
  }];

  const detail = await service.repository("repository:1");
  const associations = detail.project.worktrees[1].associations;
  assert.deepEqual(associations.map((entry) => entry.workItemId), ["work_item:active"]);
  assert.deepEqual(detail.project.worktrees[1].deletionBlocker, {
    code: "WORK_ITEM_ASSOCIATED",
    reason: "This Worktree is still associated with WorkItem “Repair workspace routing” (work_item:active). Complete or move it before deleting the Worktree."
  });

  await assert.rejects(
    () => service.deleteWorktree("repository:1", "wt:feature"),
    (error) => error.code === "WORK_ITEM_ASSOCIATED"
      && error.message.includes("Repair workspace routing")
      && error.message.includes("work_item:active")
      && error.message.includes("Complete or move it")
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(deletionFailures, [{
    repositoryId: "repository:1",
    worktreeId: "wt:feature",
    code: "WORK_ITEM_ASSOCIATED",
    reason: "This Worktree is still associated with WorkItem “Repair workspace routing” (work_item:active). Complete or move it before deleting the Worktree."
  }]);
});

test("reviewed plan preserves main and commits each dirty task Worktree before deterministic merge", async () => {
  const { service, calls } = memoryFixture();
  const plan = await service.preflight("repository:1");
  assert.deepEqual(plan.plan.items.map((item) => item.worktreeId), ["wt:main", "wt:feature"]);
  assert.deepEqual(plan.plan.mergeOrder, ["wt:feature"]);
  assert.equal(plan.status, "awaiting_confirmation");
  await assert.rejects(() => service.confirm(plan.id, { confirmed: true, planFingerprint: "wrong" }), {
    code: "EXPLICIT_CONFIRMATION_REQUIRED"
  });

  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const completed = await waitForJob(service, plan.id, "completed");
  assert.deepEqual(calls, ["commit:/repo-feature", "merge:feature:1:commit"]);
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
  const canceled = await service.cancel(stale.id);

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.phase, "canceled");
  assert.ok(canceled.completedAt);
  assert.equal(canceled.audit.at(-1).event, "execution_canceled");
  const fresh = await service.preflight("repository:1");
  assert.equal(fresh.status, "awaiting_confirmation");
  assert.notEqual(fresh.id, stale.id);
});

test("confirmation revalidates the reviewed plan before queuing any Git operation", async () => {
  const { service, calls, worktrees } = memoryFixture();
  const plan = await service.preflight("repository:1");
  worktrees[1].statusSummary = " M feature.txt\n?? added-after-review.txt";
  worktrees[1].changedFiles.push("added-after-review.txt");

  const stale = await service.confirm(plan.id, {
    confirmed: true,
    planFingerprint: plan.planFingerprint
  });

  assert.equal(stale.status, "awaiting_confirmation");
  assert.equal(stale.phase, "plan_stale");
  assert.equal(stale.audit.at(-1).code, "PLAN_STALE");
  assert.deepEqual(calls, []);
});

test("main changes introduced after review produce a recoverable stale plan without Git operations", async () => {
  const { service, calls, worktrees } = memoryFixture();
  const plan = await service.preflight("repository:1");
  worktrees[0].dirty = true;
  worktrees[0].statusSummary = " M local-main.txt";
  worktrees[0].changedFiles = ["local-main.txt"];

  const stale = await service.confirm(plan.id, {
    confirmed: true,
    planFingerprint: plan.planFingerprint
  });

  assert.equal(stale.status, "awaiting_confirmation");
  assert.equal(stale.phase, "plan_stale");
  assert.equal(stale.audit.at(-1).code, "MAIN_DIRTY");
  assert.match(stale.error, /Nothing was changed/);
  assert.deepEqual(calls, []);
});

test("a running task stops at the next safe boundary and automatically creates a fresh plan", async () => {
  let releaseCommit;
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  const { service, store, calls } = memoryFixture({ commitGate });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  await waitForJobWhere(service, plan.id, (job) => job.phase === "committing");

  const stopping = await service.cancel(plan.id, { replan: true });
  assert.equal(stopping.status, "cancellation_requested");
  assert.equal(stopping.phase, "stopping");
  releaseCommit();

  const canceled = await waitForJob(service, plan.id, "canceled");
  assert.equal(canceled.plan.items.find((item) => item.worktreeId === "wt:feature").commitStatus, "completed");
  assert.deepEqual(calls, ["commit:/repo-feature"]);
  const replacement = store.listWorktreeIntegrationJobs("repository:1")
    .find((job) => job.id !== plan.id && job.status === "awaiting_confirmation");
  assert.ok(replacement, JSON.stringify(store.listWorktreeIntegrationJobs("repository:1")));
  assert.equal(canceled.replacementJobId, replacement.id);
});

test("stop and re-preflight is idempotent for an inactive task", async () => {
  const { service, store } = memoryFixture();
  const plan = await service.preflight("repository:1");
  const replacement = await service.cancel(plan.id, { replan: true });
  const retried = await service.cancel(plan.id, { replan: true });

  assert.equal(replacement.id, retried.id);
  assert.equal(store.listWorktreeIntegrationJobs("repository:1").length, 2);
});

test("a persisted stop request completes and rebuilds its plan after backend recovery", async () => {
  const { service, store } = memoryFixture();
  const plan = await service.preflight("repository:1");
  const persisted = store.getWorktreeIntegrationJob(plan.id);
  store.updateWorktreeIntegrationJob(plan.id, {
    status: "cancellation_requested",
    phase: "stopping",
    details: { ...persisted.details, replanAfterCancel: true }
  });

  assert.equal(await service.recover(), 1);
  assert.equal(service.get(plan.id).status, "canceled");
  const replacement = store.listWorktreeIntegrationJobs("repository:1")
    .find((job) => job.id !== plan.id);
  assert.equal(replacement.status, "awaiting_confirmation");
});

test("merge conflict preserves a paused item and retry resumes the same idempotent task", async () => {
  const { service } = memoryFixture({ conflictOnce: true });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForJob(service, plan.id, "paused");
  assert.equal(paused.phase, "conflict");
  assert.equal(paused.plan.items[1].mergeStatus, "conflict");
  assert.deepEqual(paused.plan.items[1].conflictFiles, ["shared.txt"]);

  service.retry(plan.id);
  const completed = await waitForJob(service, plan.id, "completed");
  assert.equal(completed.plan.items[1].mergeStatus, "recovered");
  assert.equal(completed.plan.items[0].commitStatus, "not_needed");
});

test("stop and re-preflight aborts the task-owned main merge before creating a replacement plan", async () => {
  const { service, store, calls } = memoryFixture({ conflictOnce: true });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForJob(service, plan.id, "paused");

  const replacement = await service.cancel(paused.id, { replan: true });

  assert.equal(replacement.status, "awaiting_confirmation");
  assert.deepEqual(calls.slice(-1), ["abort-merge:feature:1:commit"]);
  const canceled = store.getWorktreeIntegrationJob(paused.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.phase, "canceled");
  assert.equal(canceled.details.replacementJobId, replacement.id);
  assert.ok(canceled.details.audit.some((entry) => entry.event === "conflict_merge_aborted"));
  assert.ok(canceled.details.audit.some((entry) => entry.event === "replacement_preflight_ready"));
});

test("stop and re-preflight never creates a replacement plan when main cannot be restored", async () => {
  const restoreError = new Error("Git aborted the merge, but main did not return to its recorded clean state.");
  restoreError.code = "MAIN_NOT_RESTORED";
  const { service, store, calls } = memoryFixture({ conflictOnce: true, abortMergeError: restoreError });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForJob(service, plan.id, "paused");

  const failed = await service.cancel(paused.id, { replan: true });

  assert.equal(failed.id, plan.id);
  assert.equal(failed.status, "paused");
  assert.equal(failed.phase, "replanning_cleanup_failed");
  assert.match(failed.error, /did not return to its recorded clean state/);
  assert.deepEqual(calls.slice(-1), ["abort-merge:feature:1:commit"]);
  assert.equal(store.listWorktreeIntegrationJobs("repository:1").length, 1);
  assert.ok(failed.audit.some((entry) =>
    entry.event === "conflict_merge_cleanup_failed" && entry.code === "MAIN_NOT_RESTORED"));
});

test("a paused merge conflict launches an Agent and resumes automatically when its Session completes", async () => {
  const { service, calls } = memoryFixture({ conflictOnce: true });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForJob(service, plan.id, "paused");

  const delegated = await service.resolveConflictWithAgent(paused.id);

  assert.equal(delegated.status, "paused");
  assert.equal(delegated.phase, "conflict_resolution_running");
  assert.equal(delegated.conflictResolution.workspace.path, "/repo-integration");
  assert.equal(delegated.conflictResolution.sessionId, "session:conflict");
  assert.equal(delegated.conflictResolution.worktreeId, "wt:feature");
  assert.ok(delegated.conflictResolution.conflictKey);
  assert.equal(delegated.conflictResolution.agentName, "Conflict Agent");
  assert.deepEqual(calls.slice(-2), [
    "prepare-conflict:feature:1:commit",
    "launch-agent:wt:feature"
  ]);
  assert.ok(delegated.audit.some((entry) => entry.event === "conflict_workspace_created"));
  assert.ok(delegated.audit.some((entry) => entry.event === "conflict_agent_started"));
  const [resuming] = service.reconcileConflictResolutionSession(delegated.conflictResolution.sessionId);
  assert.equal(resuming.status, "queued");
  assert.equal(resuming.phase, "conflict_resolution_resume_queued");
  assert.equal(resuming.conflictResolution.status, "ready");
  assert.ok(resuming.audit.some((entry) =>
    entry.event === "conflict_agent_completed" && entry.automaticResume === true));
  const completed = await waitForJob(service, plan.id, "completed");
  assert.ok(completed.audit.some((entry) => entry.event === "conflict_resolution_verified"
    && entry.sessionName === "Resolve conflicts"
    && entry.branchName === "integration/job-1"
    && entry.worktreePath === "/repo-integration"
    && entry.retryCount === 0
    && entry.failureStage === "completed"));
});

test("conflict Session title collisions are retried automatically with structured identifiers", async () => {
  const titleConflict = new Error("A session with that title already exists.");
  titleConflict.code = "SESSION_TITLE_CONFLICT";
  const concurrentCreation = new Error("Another session is being created.");
  concurrentCreation.code = "SESSION_CREATION_IN_PROGRESS";
  const { service, calls, removalInputs } = memoryFixture({
    conflictOnce: true,
    launchConflictErrors: [titleConflict, concurrentCreation]
  });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  await waitForJob(service, plan.id, "paused");

  const delegated = await service.resolveConflictWithAgent(plan.id);

  assert.equal(delegated.conflictResolution.sessionName, "Resolve conflicts");
  assert.equal(delegated.conflictResolution.retryCount, 2);
  assert.equal(calls.filter((call) => call === "launch-agent:wt:feature").length, 3);
  assert.equal(removalInputs.length, 0);
  assert.ok(delegated.audit.some((entry) => entry.event === "conflict_fallback_retry"
    && entry.failureStage === "session_creation"
    && entry.code === "SESSION_TITLE_CONFLICT"
    && entry.branchName === "integration/job-1"
    && entry.worktreePath === "/repo-integration"));
  assert.ok(delegated.audit.some((entry) => entry.event === "conflict_fallback_retry"
    && entry.failureStage === "session_creation"
    && entry.code === "SESSION_CREATION_IN_PROGRESS"
    && entry.retryCount === 2));
  assert.ok(delegated.audit.some((entry) => entry.event === "conflict_agent_started"
    && entry.sessionName === "Resolve conflicts"
    && entry.retryCount === 2));
});

test("concurrent duplicate triggers share the same in-flight conflict launch instead of returning a race error", async () => {
  const { service, calls } = memoryFixture({ conflictOnce: true, conflictSessionStatus: "running" });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  await waitForJob(service, plan.id, "paused");

  const [left, right] = await Promise.all([
    service.resolveConflictWithAgent(plan.id),
    service.resolveConflictWithAgent(plan.id)
  ]);

  assert.equal(left.conflictResolution.sessionId, right.conflictResolution.sessionId);
  assert.equal(left.conflictResolution.workspace.worktreeId, right.conflictResolution.workspace.worktreeId);
  assert.equal(calls.filter((call) => call === "launch-agent:wt:feature").length, 1);
});

test("conflict fallback retries are bounded and preserve every existing Worktree on failure", async () => {
  const failures = Array.from({ length: 3 }, () => {
    const error = new Error("main is temporarily dirty");
    error.code = "MAIN_DIRTY";
    return error;
  });
  const { service, removalInputs } = memoryFixture({
    conflictOnce: true,
    prepareConflictErrors: failures
  });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  await waitForJob(service, plan.id, "paused");

  await assert.rejects(
    () => service.resolveConflictWithAgent(plan.id),
    (error) => error.code === "CONFLICT_FALLBACK_RETRY_EXHAUSTED"
      && error.failureStage === "workspace_creation"
      && error.retryCount === 3
      && /Root cause: main is temporarily dirty/.test(error.message)
      && /Preserved all branches, Worktrees, commits/.test(error.message)
  );
  const failed = service.get(plan.id);
  assert.equal(failed.status, "paused");
  assert.equal(removalInputs.length, 0);
  assert.equal(failed.audit.filter((entry) => entry.event === "conflict_fallback_retry").length, 2);
});

test("a recoverable commit failure re-detects state and retries without manual intervention", async () => {
  const commitFailure = new Error("transient commit hook failure");
  commitFailure.code = "WORKTREE_COMMIT_FAILED";
  const { service, calls } = memoryFixture({ commitErrors: [commitFailure] });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const completed = await waitForJob(service, plan.id, "completed");

  assert.equal(calls.filter((call) => call === "commit:/repo-feature").length, 2);
  assert.ok(completed.audit.some((entry) => entry.event === "worktree_state_refreshed"));
  assert.ok(completed.audit.some((entry) => entry.event === "integration_stage_retry"
    && entry.failureStage === "worktree_commit"
    && entry.retryCount === 1));
});

test("an unrelated Agent completion signal does not change a paused conflict task", async () => {
  const { service } = memoryFixture({ conflictOnce: true, conflictSessionStatus: "running" });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  await waitForJob(service, plan.id, "paused");
  await service.resolveConflictWithAgent(plan.id);

  assert.deepEqual(service.reconcileConflictResolutionSession("session:unrelated"), []);
  assert.equal(service.get(plan.id).phase, "conflict_resolution_running");
});

test("retry is rejected while the conflict Agent is still running", async () => {
  const { service, calls } = memoryFixture({ conflictOnce: true, conflictSessionStatus: "running" });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  await waitForJob(service, plan.id, "paused");
  await service.resolveConflictWithAgent(plan.id);

  assert.throws(() => service.retry(plan.id), { code: "CONFLICT_AGENT_RUNNING" });
  assert.equal(calls.filter((call) => call.startsWith("merge:")).length, 1);
});

test("successive conflicting Worktrees promote only their matching verified Agent result", async () => {
  const { service, calls } = memoryFixture({ conflictAttempts: [1, 1], mainDirty: false, featureDirty: false });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });

  const firstConflict = await waitForJobWhere(service, plan.id, (job) =>
    job.status === "paused" && job.currentWorktreeId === "wt:feature");
  assert.equal(firstConflict.conflictResolution, undefined);
  const firstReady = await service.resolveConflictWithAgent(plan.id);
  assert.equal(firstReady.conflictResolution.worktreeId, "wt:feature");
  assert.equal(service.get(plan.id).phase, "conflict_resolution_resume_queued");
  const secondConflict = await waitForJobWhere(service, plan.id, (job) =>
    job.status === "paused" && job.currentWorktreeId === "wt:feature-two");
  assert.equal(secondConflict.plan.items.find((item) => item.worktreeId === "wt:feature").mergeStatus, "recovered");
  assert.equal(secondConflict.plan.items.find((item) => item.worktreeId === "wt:feature-two").mergeStatus, "conflict");
  assert.equal(secondConflict.conflictResolution, undefined);

  const secondReady = await service.resolveConflictWithAgent(plan.id);
  assert.equal(secondReady.conflictResolution.worktreeId, "wt:feature-two");
  assert.notEqual(secondReady.conflictResolution.sessionId, firstReady.conflictResolution.sessionId);
  assert.equal(service.get(plan.id).phase, "conflict_resolution_resume_queued");
  const completed = await waitForJob(service, plan.id, "completed");
  assert.equal(completed.conflictResolution, undefined);
  assert.equal(completed.plan.items.find((item) => item.worktreeId === "wt:feature-two").mergeStatus, "recovered");
  assert.equal(completed.audit.filter((entry) => entry.event === "conflict_resolution_verified").length, 2);
  assert.equal(completed.audit.filter((entry) =>
    entry.event === "conflict_agent_completed" && entry.automaticResume === true).length, 2);
  assert.equal(completed.audit.filter((entry) => entry.event === "retry_requested").length, 0);
  assert.equal(calls.includes("merge:integration:feature:1"), true);
  assert.equal(calls.includes("merge:integration:feature:2"), true);
});

test("an invalid Agent result stays paused and is never promoted into main", async () => {
  const invalid = new Error("Commit every resolved project change, then retry.");
  invalid.code = "RESOLUTION_WORKTREE_DIRTY";
  const { service, calls } = memoryFixture({ conflictOnce: true, resolutionInspectionError: invalid });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  await waitForJob(service, plan.id, "paused");
  await service.resolveConflictWithAgent(plan.id);
  assert.equal(service.get(plan.id).phase, "conflict_resolution_resume_queued");
  const rejected = await waitForJobWhere(service, plan.id, (job) =>
    job.status === "paused" && job.phase === "failed");

  assert.equal(rejected.phase, "failed");
  assert.equal(rejected.audit.some((entry) => entry.code === "RESOLUTION_WORKTREE_DIRTY"), true);
  assert.match(rejected.error, /Commit every resolved project change/);
  assert.equal(calls.some((call) => call.startsWith("merge:integration:")), false);
});

test("an externally resolved conflict is detected and the paused job resumes idempotently", async () => {
  const { service, calls } = memoryFixture({ conflictOnce: true, externalConflictResolved: true });
  const plan = await service.preflight("repository:1");
  await service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForJob(service, plan.id, "paused");

  const resumed = await service.resolveConflictWithAgent(paused.id);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.plan.items[1].mergeStatus, "recovered");
  assert.equal(calls.includes("launch-agent:wt:feature"), false);

  const completed = await waitForJob(service, plan.id, "completed");
  assert.equal(completed.plan.items[1].mergeStatus, "recovered");
  assert.ok(completed.audit.some((entry) => entry.event === "external_conflict_resolution_detected"));
});

test("blocking preflight risks cannot be confirmed", async () => {
  const { service } = memoryFixture({ blockingRisk: true });
  const plan = await service.preflight("repository:1");
  assert.equal(plan.plan.blockingRisks[0].code, "WORKTREE_LOCKED");
  await assert.rejects(
    () => service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint }),
    { code: "PREFLIGHT_RISKS_UNRESOLVED" }
  );
});

test("active Sessions block integration until their run stops", async () => {
  const { service } = memoryFixture({ activeFeatureSession: true });
  const plan = await service.preflight("repository:1");
  assert.equal(plan.plan.blockingRisks.some((risk) => risk.code === "ACTIVE_SESSION_IN_PROGRESS"), true);
  assert.equal(plan.plan.items[1].associations[0].active, true);
  await assert.rejects(
    () => service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint }),
    { code: "PREFLIGHT_RISKS_UNRESOLVED" }
  );
});

test("protected files require an explicit reviewed decision before any integration commit", async () => {
  const { service, calls } = memoryFixture({ protectedPaths: [".corptie/private.json"] });
  const plan = await service.preflight("repository:1");
  const feature = plan.plan.items.find((item) => item.worktreeId === "wt:feature");
  assert.deepEqual(feature.commitProtection.protectedPaths, [".corptie/private.json"]);
  assert.equal(feature.commitProtection.requiresDecision, true);
  await assert.rejects(
    () => service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint }),
    { code: "GIT_COMMIT_PROTECTION_REQUIRED" }
  );

  await service.confirm(plan.id, {
    confirmed: true,
    planFingerprint: plan.planFingerprint,
    commitProtectionDecisions: [{
      worktreeId: "wt:feature", decision: "ignore", neverRemind: true
    }]
  });
  await waitForJob(service, plan.id, "completed");
  assert.equal(calls.includes("protect:/repo-feature:ignore:true"), true);
});

test("a dirty branch still has a merge step when its pre-commit HEAD is already in main", async () => {
  const { service } = memoryFixture({ featureAlreadyMerged: true });
  const plan = await service.preflight("repository:1");
  assert.deepEqual(plan.plan.mergeOrder, ["wt:feature"]);
  assert.equal(plan.plan.items[1].mergeStatus, "pending");
});

test("preflight completes when all task Worktrees are already integrated and main is clean", async () => {
  const { service } = memoryFixture({ featureAlreadyMerged: true, featureDirty: false });
  const plan = await service.preflight("repository:1");

  assert.deepEqual(plan.plan.items, []);
  assert.deepEqual(plan.plan.mergeOrder, []);
  assert.equal(plan.status, "completed");
});

test("dirty main is detected as a read-only blocker and is never committed", async () => {
  const { service, calls, worktrees } = memoryFixture({ mainDirty: true });
  const before = structuredClone(worktrees[0]);
  const plan = await service.preflight("repository:1");
  const main = plan.plan.items.find((item) => item.isMain);

  assert.equal(plan.status, "awaiting_confirmation");
  assert.equal(main.dirty, true);
  assert.equal(main.commitStatus, "not_needed");
  assert.equal(main.commitMessage, null);
  assert.equal(plan.plan.blockingRisks.some((risk) => risk.code === "MAIN_UNCOMMITTED_CHANGES"), true);
  await assert.rejects(
    () => service.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint }),
    { code: "PREFLIGHT_RISKS_UNRESOLVED" }
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(worktrees[0], before);
});

test("task conflicts and dirty main are reported together without mutating either workspace", async () => {
  const { service, calls, worktrees } = memoryFixture({ mainDirty: true, featureConflict: true });
  const before = structuredClone(worktrees);
  const plan = await service.preflight("repository:1");
  const codes = new Set(plan.plan.blockingRisks.map((risk) => risk.code));

  assert.equal(codes.has("MAIN_UNCOMMITTED_CHANGES"), true);
  assert.equal(codes.has("UNRESOLVED_CONFLICTS"), true);
  assert.equal(codes.has("GIT_OPERATION_IN_PROGRESS"), true);
  const canceled = await service.cancel(plan.id);
  assert.equal(canceled.status, "canceled");
  assert.deepEqual(calls, []);
  assert.deepEqual(worktrees, before);
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

test("cleanup removes only confirmed merged clean unassociated Worktrees and reports every skip", async () => {
  const { service, calls, worktrees } = memoryFixture({
    mainDirty: false,
    featureAlreadyMerged: true,
    featureDirty: false
  });
  worktrees.push(
    { ...structuredClone(worktrees[1]), worktreeId: "wt:unmerged", path: "/repo-unmerged", branchName: "feature/unmerged", mergedIntoMain: false },
    { ...structuredClone(worktrees[1]), worktreeId: "wt:dirty", path: "/repo-dirty", branchName: "feature/dirty", dirty: true },
    {
      ...structuredClone(worktrees[1]), worktreeId: "wt:owned", path: "/repo-owned", branchName: "feature/owned",
      sessions: [{ logicalSessionId: "logical:owned", sessionId: null, active: true, workItemId: "work_item:owned" }]
    }
  );

  const result = await service.cleanupMergedWorktrees("repository:1", { worktreeIds: ["wt:feature"] });

  assert.deepEqual(result.counts, { removed: 1, skipped: 3, failed: 0 });
  assert.deepEqual(result.removed.map((entry) => entry.worktreeId), ["wt:feature"]);
  assert.deepEqual(new Set(result.skipped.map((entry) => entry.code)), new Set([
    "NOT_MERGED_INTO_MAIN", "UNCOMMITTED_CHANGES", "WORK_ITEM_ASSOCIATED"
  ]));
  assert.deepEqual(calls, ["remove:wt:feature"]);
});

test("cleanup scan and execution share association rules for none, completed, and unfinished WorkItems", async () => {
  const { service, calls, worktrees, workItems, removalInputs } = memoryFixture({
    mainDirty: false,
    featureAlreadyMerged: true,
    featureDirty: false
  });
  const template = structuredClone(worktrees[1]);
  workItems.set("work_item:done", { id: "work_item:done", title: "Finished migration", status: "completed" });
  workItems.set("work_item:active", { id: "work_item:active", title: "Repair routing", status: "in_progress" });
  worktrees.push(
    {
      ...structuredClone(template), worktreeId: "wt:completed", path: "/repo-completed",
      branchName: "feature/completed", sessions: [{
        logicalSessionId: "logical:completed", sessionId: null, active: false, workItemId: "work_item:done"
      }]
    },
    {
      ...structuredClone(template), worktreeId: "wt:active", path: "/repo-active",
      branchName: "feature/active", sessions: [{
        logicalSessionId: "logical:active-work-item", sessionId: null, active: false,
        workItemId: "work_item:active"
      }]
    }
  );

  const scan = await service.repository("repository:1");
  const scanCandidates = scan.project.worktrees.filter((worktree) => !worktree.deletionBlocker);
  assert.deepEqual(scanCandidates.map((worktree) => worktree.worktreeId), ["wt:feature", "wt:completed"]);
  assert.equal(scan.project.worktrees.find((worktree) => worktree.worktreeId === "wt:completed").associations.length, 0);
  assert.deepEqual(scan.project.worktrees.find((worktree) => worktree.worktreeId === "wt:active").deletionBlocker, {
    code: "WORK_ITEM_ASSOCIATED",
    reason: "This Worktree is still associated with WorkItem “Repair routing” (work_item:active). Complete or move it before deleting the Worktree."
  });

  const result = await service.cleanupMergedWorktrees("repository:1", {
    worktreeIds: scanCandidates.map((worktree) => worktree.worktreeId)
  });

  assert.deepEqual(result.counts, { removed: scanCandidates.length, skipped: 1, failed: 0 });
  assert.deepEqual(result.removed.map((entry) => entry.worktreeId), ["wt:completed", "wt:feature"]);
  assert.deepEqual(result.skipped.map((entry) => ({ worktreeId: entry.worktreeId, code: entry.code })), [
    { worktreeId: "wt:active", code: "WORK_ITEM_ASSOCIATED" }
  ]);
  assert.deepEqual(calls, ["remove:wt:completed", "remove:wt:feature"]);
  assert.deepEqual(removalInputs.find((input) => input.worktreeId === "wt:feature").ignoreLogicalSessionIds, []);
  assert.deepEqual(removalInputs.find((input) => input.worktreeId === "wt:completed").ignoreLogicalSessionIds, [
    "logical:completed"
  ]);
});

test("cleanup reports the latest WorkItem blocker when association state changes after scan", async () => {
  const { service, calls, worktrees, workItems } = memoryFixture({
    mainDirty: false,
    featureAlreadyMerged: true,
    featureDirty: false
  });
  const scan = await service.repository("repository:1");
  assert.equal(scan.project.worktrees[1].deletionBlocker, null);

  workItems.set("work_item:new", { id: "work_item:new", title: "New follow-up", status: "todo" });
  worktrees[1].sessions = [{
    logicalSessionId: "logical:new", sessionId: null, active: false, workItemId: "work_item:new"
  }];

  const result = await service.cleanupMergedWorktrees("repository:1", { worktreeIds: ["wt:feature"] });

  assert.deepEqual(result.counts, { removed: 0, skipped: 1, failed: 0 });
  assert.deepEqual(result.skipped, [{
    worktreeId: "wt:feature",
    branchName: "feature/one",
    path: "/repo-feature",
    status: "skipped",
    code: "WORK_ITEM_ASSOCIATED",
    reason: "This Worktree is still associated with WorkItem “New follow-up” (work_item:new). Complete or move it before deleting the Worktree.",
    removal: null
  }]);
  assert.deepEqual(calls, []);
});

test("individual safe deletion returns a concrete blocker and never calls Git", async () => {
  const { service, calls } = memoryFixture({ featureAlreadyMerged: true, featureDirty: true });

  await assert.rejects(
    () => service.deleteWorktree("repository:1", "wt:feature"),
    (error) => error.code === "UNCOMMITTED_CHANGES" && /uncommitted changes/.test(error.message)
  );
  assert.deepEqual(calls, []);
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
    const stopping = store.createWorktreeIntegrationJob({
      repositoryId: "repository:1", planFingerprint: "stopping-fingerprint",
      details: { plan: { items: [] }, replanAfterCancel: true, audit: [{ event: "cancellation_requested" }] }
    });
    store.updateWorktreeIntegrationJob(stopping.id, {
      status: "cancellation_requested", phase: "stopping"
    });
    await store.close();

    store = new CorptieStore({ dbPath });
    await store.initialize();
    const recovered = store.listRecoverableWorktreeIntegrationJobs();
    assert.equal(recovered.length, 2);
    const recoveredQueued = recovered.find((job) => job.id === created.id);
    const recoveredStopping = recovered.find((job) => job.id === stopping.id);
    assert.equal(recoveredQueued.details.plan.items[0].mergeStatus, "conflict");
    assert.deepEqual(recoveredQueued.details.audit, [{ event: "paused" }]);
    assert.equal(recoveredStopping.details.replanAfterCancel, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
