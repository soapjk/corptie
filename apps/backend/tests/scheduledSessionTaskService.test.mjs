import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeConditionScript,
  ScheduledSessionTaskService,
  processObservationFromPs
} from "../src/application/scheduledSessionTaskService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-scheduled-session-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  await store.initialize();
  store.upsertSession({
    id: "session:stable",
    title: "Stable",
    agent: "Agent",
    provider: "codex-app-server",
    status: "complete"
  });
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:stable",
    legacySessionId: "session:stable",
    providerThreadId: "provider:old",
    providerSessionId: "provider:old",
    providerId: "codex-app-server",
    boundCwd: directory,
    title: "Stable"
  });
  const core = new CollaborationCore(store);
  core.registerAgent({ agentId: "agent:owner", name: "Owner" });
  core.registerAgent({ agentId: "agent:other", name: "Other" });
  core.bindSession({ agentId: "agent:owner", sessionId: "session:stable" });
  let current = new Date("2026-08-22T12:00:00.000Z");
  let authorizationActive = true;
  const queued = [];
  const service = new ScheduledSessionTaskService({
    store,
    environment: options.environment ?? "development",
    now: () => new Date(current),
    missedGraceMs: options.missedGraceMs ?? 2_000,
    leaseOwner: options.leaseOwner ?? "scheduler:test",
    authorize: ({ actor, logicalSessionId }) => {
      if (!authorizationActive || actor.id !== "agent:owner" || logicalSessionId !== "logical:stable") {
        const error = new Error("forbidden");
        error.code = "AUTHORIZATION_REVOKED";
        throw error;
      }
      return { objectiveId: null };
    },
    resolveRoute: async (logicalSessionId) => {
      const logical = store.getLogicalSession(logicalSessionId);
      if (!logical) {
        const error = new Error("session missing");
        error.code = "SESSION_NOT_FOUND";
        throw error;
      }
      return {
        sessionId: logical.legacySessionId,
        agentId: "agent:owner",
        binding: logical.activeBinding
      };
    },
    enqueue: options.enqueue ?? ((work) => {
      queued.push(work);
      return store.enqueueAgentWorkItem(work);
    }),
    evaluateCondition: options.evaluateCondition,
    inspectProcess: options.inspectProcess
  });
  return {
    directory, dbPath, store, core, service, queued,
    actor: { type: "agent", id: "agent:owner" },
    setNow(value) { current = new Date(value); },
    advance(ms) { current = new Date(current.getTime() + ms); },
    revokeAuthorization() { authorizationActive = false; }
  };
}

async function cleanup(value) {
  value.service.stop();
  await value.store.close();
  await rm(value.directory, { recursive: true, force: true });
}

test("validates time zones, schedule fields, authorization, and full lifecycle operations", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.create({
      logicalSessionId: "logical:stable",
      message: "check",
      scheduleType: "once",
      runAt: "2026-08-22T12:01:00Z",
      timezone: "Mars/Olympus"
    }, f.actor), (error) => error.code === "INVALID_SCHEDULED_SESSION_TASK");
    assert.throws(() => f.service.create({
      logicalSessionId: "logical:stable",
      message: "check",
      scheduleType: "interval",
      intervalSeconds: 60
    }, { type: "agent", id: "agent:other" }), (error) => error.code === "AUTHORIZATION_REVOKED");

    const created = f.service.create({
      logicalSessionId: "logical:stable",
      message: { text: "check", payload: { report: true } },
      scheduleType: "interval",
      intervalSeconds: 60,
      timezone: "Asia/Shanghai"
    }, f.actor);
    assert.equal(created.logicalSessionId, "logical:stable");
    assert.equal(created.intervalSeconds, 60);
    assert.equal(created.environment, "development");
    assert.equal(f.service.list({}, f.actor).length, 1);

    const paused = f.service.pause(created.taskId, f.actor);
    assert.equal(paused.status, "paused");
    const resumed = f.service.resume(created.taskId, f.actor);
    assert.equal(resumed.status, "active");
    const updated = f.service.update(created.taskId, {
      intervalSeconds: 120,
      resourceVersion: resumed.resourceVersion
    }, f.actor);
    assert.equal(updated.intervalSeconds, 120);
    assert.throws(() => f.service.update(created.taskId, {
      intervalSeconds: 180,
      resourceVersion: resumed.resourceVersion
    }, f.actor), (error) => error.code === "RESOURCE_VERSION_CONFLICT");
    const immediate = await f.service.runNow(created.taskId, f.actor);
    assert.equal(immediate.status, "queued");
    assert.equal(f.store.getScheduledSessionTask(created.taskId).status, "active");
    const cancelled = f.service.cancel(created.taskId, f.actor);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(f.service.get(created.taskId, f.actor).events.length >= 5);
  } finally {
    await cleanup(f);
  }
});

test("one-time and interval due runs enqueue stable work without interrupting a busy Session", async () => {
  const f = await fixture();
  try {
    f.store.enqueueAgentWorkItem({
      workItemId: "busy", agentId: "agent:owner", sessionId: "session:stable",
      kind: "user", priority: 100, text: "busy", source: {}, createdAt: "2026-08-22T11:59:00Z"
    });
    f.store.claimAgentWorkItem("busy");
    const once = f.service.create({
      logicalSessionId: "logical:stable", message: "wake once", scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z", timezone: "UTC"
    }, f.actor);
    f.advance(1_000);
    await f.service.tick();
    assert.equal(f.store.getScheduledSessionTask(once.taskId).status, "completed");
    assert.equal(f.queued.length, 1);
    assert.equal(f.store.getAgentWorkItem(f.queued[0].workItemId).status, "queued");
    assert.equal(f.store.getRunningAgentWorkItemForSession("session:stable").workItemId, "busy");

    const interval = f.service.create({
      logicalSessionId: "logical:stable", message: "wake interval", scheduleType: "interval",
      runAt: "2026-08-22T12:00:02Z", intervalSeconds: 10, timezone: "UTC"
    }, f.actor);
    f.advance(1_000);
    await f.service.tick();
    assert.equal(f.store.getScheduledSessionTask(interval.taskId).nextRunAt, "2026-08-22T12:00:12.000Z");
  } finally {
    await cleanup(f);
  }
});

test("delivery resolves the latest Provider binding after a Provider switch", async () => {
  const f = await fixture();
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "route latest", scheduleType: "once",
      runAt: "2026-08-22T12:00:05Z", timezone: "UTC"
    }, f.actor);
    const before = f.store.getLogicalSession("logical:stable");
    f.store.beginWorkspaceTransition({
      transitionId: "transition:provider",
      logicalSessionId: "logical:stable",
      transitionKind: "provider",
      targetProviderId: "claude-sdk",
      targetCwd: f.directory,
      sourceRoutingVersion: before.routingVersion,
      phase: "waitingForTurn",
      strategy: "fork"
    });
    f.store.commitWorkspaceTransition("transition:provider", {
      providerThreadId: "provider:new",
      providerSessionId: "provider:new",
      providerId: "claude-sdk",
      boundCwd: f.directory,
      sessionProjection: {
        status: "complete",
        external: { provider: "claude-sdk", threadId: "provider:new", sessionId: "provider:new" }
      }
    });
    f.advance(5_000);
    await f.service.tick();
    const run = f.store.listScheduledSessionRuns(task.taskId).find((entry) => entry.status === "queued");
    assert.equal(run.providerSessionId, "provider:new");
    assert.equal(run.routingVersion, 2);
    assert.equal(run.bindingId, f.store.getLogicalSession("logical:stable").activeBinding.bindingId);
  } finally {
    await cleanup(f);
  }
});

test("delivery resolves the latest binding after a Workspace transition", async () => {
  const f = await fixture();
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "route workspace", scheduleType: "once",
      runAt: "2026-08-22T12:00:05Z", timezone: "UTC"
    }, f.actor);
    const before = f.store.getLogicalSession("logical:stable");
    const targetCwd = join(f.directory, "next-workspace");
    f.store.beginWorkspaceTransition({
      transitionId: "transition:workspace",
      logicalSessionId: "logical:stable",
      targetCwd,
      sourceRoutingVersion: before.routingVersion,
      phase: "waitingForTurn",
      strategy: "fork"
    });
    f.store.commitWorkspaceTransition("transition:workspace", {
      providerThreadId: "provider:workspace-new",
      providerSessionId: "provider:workspace-new",
      providerId: "test-provider",
      boundCwd: targetCwd
    });
    f.advance(5_000);
    await f.service.tick();
    const run = f.store.listScheduledSessionRuns(task.taskId).find((entry) => entry.status === "queued");
    const after = f.store.getLogicalSession("logical:stable");
    assert.equal(run.providerSessionId, "provider:workspace-new");
    assert.equal(run.bindingId, after.activeBinding.bindingId);
    assert.equal(run.routingVersion, after.routingVersion);
    assert.equal(after.activeBinding.boundCwd, targetCwd);
  } finally {
    await cleanup(f);
  }
});

test("missed schedules coalesce once, survive restart, and a lost receipt cannot duplicate delivery", async () => {
  const f = await fixture({ missedGraceMs: 500 });
  let throwsAfterInsert = true;
  f.service.enqueue = (work) => {
    const inserted = f.store.enqueueAgentWorkItem(work);
    if (throwsAfterInsert) {
      throwsAfterInsert = false;
      const error = new Error("receipt lost");
      error.code = "RECEIPT_LOST";
      throw error;
    }
    return inserted;
  };
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "recover", scheduleType: "once",
      runAt: "2026-08-22T11:00:00Z", timezone: "UTC"
    }, f.actor);
    await f.service.tick();
    assert.equal(f.store.listScheduledSessionRuns(task.taskId).some((run) => run.status === "missed"), true);
    assert.equal(f.store.getScheduledSessionTask(task.taskId).lastRunStatus, "retry_wait");
    f.advance(2_000);
    await f.service.tick();
    const work = f.store.listAgentWorkItemsForSession("session:stable")
      .filter((item) => item.source.type === "scheduled_session_task");
    assert.equal(work.length, 1);
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "completed");

    const interval = f.service.create({
      logicalSessionId: "logical:stable", message: "recover interval", scheduleType: "interval",
      runAt: "2026-08-22T10:00:00Z", intervalSeconds: 10, timezone: "UTC"
    }, f.actor);
    await f.service.tick();
    const intervalRuns = f.store.listScheduledSessionRuns(interval.taskId);
    assert.equal(intervalRuns.filter((run) => run.status === "missed").length, 1);
    assert.equal(intervalRuns.filter((run) => run.status === "queued").length, 1);
    assert.equal(new Date(f.store.getScheduledSessionTask(interval.taskId).nextRunAt) > f.service.now(), true);

    await f.store.close();
    const reopened = new CorptieStore({ dbPath: f.dbPath, configPath: join(f.directory, "config.json") });
    await reopened.initialize();
    f.store = reopened;
    assert.equal(reopened.getScheduledSessionTask(task.taskId).status, "completed");
    assert.equal(reopened.listScheduledSessionRuns(task.taskId).length >= 2, true);
  } finally {
    await cleanup(f);
  }
});

test("atomic leases prevent concurrent ticks and cancellation wins the pre-delivery race", async () => {
  const f = await fixture();
  let releaseRoute;
  const routeGate = new Promise((resolve) => { releaseRoute = resolve; });
  f.service.resolveRoute = async (logicalSessionId) => {
    await routeGate;
    const logical = f.store.getLogicalSession(logicalSessionId);
    return { sessionId: logical.legacySessionId, agentId: "agent:owner", binding: logical.activeBinding };
  };
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "race", scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z", timezone: "UTC"
    }, f.actor);
    f.advance(1_000);
    const ticking = f.service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    f.service.cancel(task.taskId, f.actor);
    releaseRoute();
    await ticking;
    assert.equal(f.queued.length, 0);
    assert.equal(f.store.listScheduledSessionRuns(task.taskId)[0].status, "cancelled");

    const second = new CorptieStore({ dbPath: f.dbPath, configPath: join(f.directory, "second.json") });
    await second.initialize();
    const due = f.store.createScheduledSessionTask({
      taskId: "scheduled_task:lease", logicalSessionId: "logical:stable", message: { text: "lease" },
      scheduleType: "once", runAt: f.service.now().toISOString(), nextRunAt: f.service.now().toISOString(),
      timezone: "UTC", missedPolicy: "coalesce_once", creatorType: "agent", creatorId: "agent:owner",
      environment: "development"
    });
    const claimAt = f.service.now().toISOString();
    const [firstClaim, secondClaim] = await Promise.all([
      Promise.resolve(f.store.claimDueScheduledSessionTasks({
        environment: "development", now: claimAt, leaseOwner: "one", leaseUntil: "2026-08-22T12:01:00Z"
      })),
      Promise.resolve(second.claimDueScheduledSessionTasks({
        environment: "development", now: claimAt, leaseOwner: "two", leaseUntil: "2026-08-22T12:01:00Z"
      }))
    ]);
    assert.equal(firstClaim.length + secondClaim.length, 1);
    assert.equal(due.taskId, "scheduled_task:lease");
    await second.close();
  } finally {
    await cleanup(f);
  }
});

test("process monitor restores polling, wakes once on termination, and records diagnostic failures", async () => {
  const observations = [
    { state: "running", status: "S" },
    { state: "indeterminate", errorCode: "PROCESS_PERMISSION_DENIED", errorMessage: "not permitted" },
    { state: "exited", reason: "process_abnormal_termination", exitStatus: { kind: "abnormal", signal: "SIGKILL", code: null } }
  ];
  const f = await fixture({ inspectProcess: async () => observations.shift() });
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable",
      message: "report process",
      scheduleType: "process",
      process: { pid: 4242, pollIntervalSeconds: 1 },
      timezone: "UTC"
    }, f.actor);
    await f.service.tick();
    assert.equal(f.store.getScheduledSessionTask(task.taskId).processState.lastObservation.state, "running");
    f.advance(1_000);
    await f.service.tick();
    assert.equal(f.store.getScheduledSessionTask(task.taskId).lastErrorCode, "PROCESS_PERMISSION_DENIED");
    f.advance(2_000);
    await f.service.tick();
    const runs = f.store.listScheduledSessionRuns(task.taskId);
    assert.equal(runs.filter((run) => run.status === "queued").length, 1);
    assert.equal(runs[0].exitStatus.kind, "abnormal");
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "completed");

    observations.push({
      state: "exited",
      reason: "process_normal_exit",
      exitStatus: { kind: "normal", code: 0, signal: null }
    });
    const normal = f.service.create({
      logicalSessionId: "logical:stable",
      message: "report normal process",
      scheduleType: "process",
      process: { pid: 4243, pollIntervalSeconds: 1 },
      timezone: "UTC"
    }, f.actor);
    await f.service.tick();
    const normalRun = f.store.listScheduledSessionRuns(normal.taskId)[0];
    assert.equal(normalRun.triggerReason, "process_normal_exit");
    assert.equal(normalRun.exitStatus.code, 0);
  } finally {
    await cleanup(f);
  }
});

test("condition tasks poll scripts until exit zero, then wake exactly once with the result", async () => {
  const observations = [
    { state: "not_matched", exitCode: 1, stdout: "waiting\n", stderr: "" },
    { state: "matched", exitCode: 0, stdout: "ready\n", stderr: "" }
  ];
  const f = await fixture({ evaluateCondition: async () => observations.shift() });
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable",
      message: "condition met",
      scheduleType: "condition",
      condition: {
        script: "test -f ready.flag",
        checkIntervalSeconds: 3,
        timeoutSeconds: 10,
        workingDirectory: f.directory
      },
      timezone: "UTC"
    }, f.actor);
    await f.service.tick();
    let stored = f.store.getScheduledSessionTask(task.taskId);
    assert.equal(stored.status, "active");
    assert.equal(stored.conditionState.lastObservation.exitCode, 1);
    assert.equal(stored.nextRunAt, "2026-08-22T12:00:03.000Z");
    assert.equal(f.queued.length, 0);

    const now = f.service.now;
    await f.store.close();
    const reopened = new CorptieStore({ dbPath: f.dbPath, configPath: join(f.directory, "reopened.json") });
    await reopened.initialize();
    f.store = reopened;
    f.service = new ScheduledSessionTaskService({
      store: reopened,
      environment: "development",
      now,
      leaseOwner: "scheduler:condition-restart",
      authorize: () => ({}),
      resolveRoute: async (logicalSessionId) => {
        const logical = reopened.getLogicalSession(logicalSessionId);
        return { sessionId: logical.legacySessionId, agentId: "agent:owner", binding: logical.activeBinding };
      },
      enqueue: (work) => {
        f.queued.push(work);
        return reopened.enqueueAgentWorkItem(work);
      },
      evaluateCondition: async () => observations.shift()
    });
    assert.equal(reopened.getScheduledSessionTask(task.taskId).conditionState.lastObservation.exitCode, 1);
    f.advance(3_000);
    await f.service.tick();
    stored = f.store.getScheduledSessionTask(task.taskId);
    assert.equal(stored.status, "completed");
    assert.equal(f.queued.length, 1);
    assert.equal(f.queued[0].source.triggerKind, "condition");
    assert.equal(f.queued[0].source.conditionResult.stdout, "ready\n");
    const run = f.store.listScheduledSessionRuns(task.taskId)[0];
    assert.equal(run.triggerReason, "condition_script_satisfied");
    assert.equal(run.conditionResult.exitCode, 0);

    f.advance(3_000);
    await f.service.tick();
    assert.equal(f.queued.length, 1);
  } finally {
    await cleanup(f);
  }
});

test("condition script execution treats nonzero as false and does not inherit backend credentials", async () => {
  process.env.CORPTIE_TEST_SECRET = "must-not-leak";
  try {
    const falseResult = await executeConditionScript({
      script: "test \"${CORPTIE_TEST_SECRET-unset}\" = must-not-leak",
      checkIntervalSeconds: 1,
      timeoutSeconds: 2,
      workingDirectory: null
    });
    assert.equal(falseResult.state, "not_matched");
    assert.equal(falseResult.exitCode, 1);
    const trueResult = await executeConditionScript({
      script: "printf ready",
      checkIntervalSeconds: 1,
      timeoutSeconds: 2,
      workingDirectory: null
    });
    assert.deepEqual(trueResult, { state: "matched", exitCode: 0, stdout: "ready", stderr: "" });
  } finally {
    delete process.env.CORPTIE_TEST_SECRET;
  }
});

test("condition scripts never execute after creator authorization is revoked", async () => {
  let executions = 0;
  const f = await fixture({
    evaluateCondition: async () => {
      executions += 1;
      return { state: "matched", exitCode: 0, stdout: "", stderr: "" };
    }
  });
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable",
      message: "must not run",
      scheduleType: "condition",
      condition: { script: "true", checkIntervalSeconds: 1 },
      timezone: "UTC"
    }, f.actor);
    f.revokeAuthorization();
    await f.service.tick();
    assert.equal(executions, 0);
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "failed");
    assert.equal(f.store.getScheduledSessionTask(task.taskId).lastErrorCode, "AUTHORIZATION_REVOKED");
    assert.equal(f.queued.length, 0);
  } finally {
    await cleanup(f);
  }
});

test("macOS wait status distinguishes normal exit codes from abnormal signals", () => {
  assert.deepEqual(
    processObservationFromPs("Sat Aug 22 21:00:00 2026 Z 1792", { pid: 42 }),
    {
      state: "exited",
      reason: "process_normal_exit",
      exitStatus: { kind: "normal", code: 7, signal: null, rawWaitStatus: 1792 }
    }
  );
  assert.deepEqual(
    processObservationFromPs("Sat Aug 22 21:00:00 2026 Z 9", { pid: 42 }),
    {
      state: "exited",
      reason: "process_abnormal_termination",
      exitStatus: { kind: "abnormal", code: null, signal: 9, rawWaitStatus: 9 }
    }
  );
});

test("creator authorization is rechecked before delivery and revocation fails without side effects", async () => {
  const f = await fixture();
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "must not wake", scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z", timezone: "UTC"
    }, f.actor);
    f.revokeAuthorization();
    f.advance(1_000);
    await f.service.tick();
    const failed = f.store.getScheduledSessionTask(task.taskId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastErrorCode, "AUTHORIZATION_REVOKED");
    assert.equal(f.queued.length, 0);
  } finally {
    await cleanup(f);
  }
});

test("deleted logical Session keeps its schedule audit and records a diagnostic terminal failure", async () => {
  const f = await fixture();
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "must not wake", scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z", timezone: "UTC"
    }, f.actor);
    f.store.deleteLogicalSessionByLegacySessionId("session:stable");
    f.advance(1_000);
    await f.service.tick();
    const failed = f.store.getScheduledSessionTask(task.taskId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastErrorCode, "SESSION_NOT_FOUND");
    assert.equal(f.store.listScheduledSessionEvents(task.taskId).at(-1).type, "ScheduledSessionRunFailed");
    assert.equal(f.queued.length, 0);
  } finally {
    await cleanup(f);
  }
});

test("Development and Production task claims and reads remain isolated even in one test database", async () => {
  const f = await fixture();
  const production = new ScheduledSessionTaskService({
    store: f.store,
    environment: "production",
    now: f.service.now,
    authorize: () => ({}),
    resolveRoute: f.service.resolveRoute,
    enqueue: f.service.enqueue
  });
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "development only", scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z", timezone: "UTC"
    }, f.actor);
    assert.deepEqual(production.list({}, f.actor), []);
    assert.throws(() => production.get(task.taskId, f.actor), (error) => error.code === "SCHEDULED_TASK_NOT_FOUND");
    f.advance(1_000);
    await production.tick();
    assert.equal(f.queued.length, 0);
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "active");
  } finally {
    production.stop();
    await cleanup(f);
  }
});
