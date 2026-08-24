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
    leaseMs: options.leaseMs,
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
      const result = store.enqueueAgentWorkItemWithResult(work);
      if (result.inserted) queued.push(work);
      return result;
    }),
    activate: options.activate,
    notify: options.notify,
    evaluateCondition: options.evaluateCondition,
    inspectProcess: options.inspectProcess
  });
  const createWithoutDefaults = service.create.bind(service);
  const createWithoutExpirationDefault = (input, actor) => createWithoutDefaults({
    ...input,
    name: input.name ?? "Test automation"
  }, actor);
  service.create = (input, actor) => createWithoutExpirationDefault(
    input.expiresAt != null || input.expiresAfterSeconds != null
      ? input
      : { ...input, expiresAfterSeconds: 86_400 },
    actor
  );
  return {
    directory, dbPath, store, core, service, queued,
    actor: { type: "agent", id: "agent:owner" },
    setNow(value) { current = new Date(value); },
    advance(ms) { current = new Date(current.getTime() + ms); },
    revokeAuthorization() { authorizationActive = false; },
    createWithoutExpirationDefault,
    createWithoutDefaults
  };
}

async function cleanup(value) {
  value.service.stop();
  await value.store.close();
  await rm(value.directory, { recursive: true, force: true });
}

test("collection and run-history queries use their covering sort indexes", async () => {
  const f = await fixture();
  try {
    const taskPlan = f.store.selectAll(
      `EXPLAIN QUERY PLAN SELECT * FROM scheduled_session_tasks
       WHERE environment = ? AND logical_session_id = ?
       ORDER BY created_at DESC, task_id ASC`,
      ["development", "logical:stable"]
    ).map((row) => row.detail).join("\n");
    const allTasksPlan = f.store.selectAll(
      `EXPLAIN QUERY PLAN SELECT * FROM scheduled_session_tasks
       WHERE environment = ? ORDER BY created_at DESC, task_id ASC`,
      ["development"]
    ).map((row) => row.detail).join("\n");
    const runPlan = f.store.selectAll(
      `EXPLAIN QUERY PLAN SELECT * FROM scheduled_session_runs
       WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      ["scheduled_task:none", 100]
    ).map((row) => row.detail).join("\n");
    assert.match(taskPlan, /idx_scheduled_session_tasks_environment_session_created/);
    assert.doesNotMatch(taskPlan, /SCAN scheduled_session_tasks|USE TEMP B-TREE/);
    assert.match(allTasksPlan, /idx_scheduled_session_tasks_environment_created/);
    assert.doesNotMatch(allTasksPlan, /SCAN scheduled_session_tasks|USE TEMP B-TREE/);
    assert.match(runPlan, /idx_scheduled_session_runs_task/);
    assert.doesNotMatch(runPlan, /SCAN scheduled_session_runs|USE TEMP B-TREE/);
  } finally {
    await cleanup(f);
  }
});

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

    assert.throws(() => f.service.pause(created.taskId, f.actor),
      (error) => error.code === "TASK_PAUSE_UNSUPPORTED");
    const updated = f.service.update(created.taskId, {
      intervalSeconds: 120,
      resourceVersion: created.resourceVersion
    }, f.actor);
    assert.equal(updated.intervalSeconds, 120);
    assert.throws(() => f.service.update(created.taskId, {
      intervalSeconds: 180,
      resourceVersion: created.resourceVersion
    }, f.actor), (error) => error.code === "RESOURCE_VERSION_CONFLICT");
    const immediate = await f.service.runNow(created.taskId, f.actor);
    assert.equal(immediate.status, "queued");
    assert.equal(f.store.getScheduledSessionTask(created.taskId).status, "active");
    const performance = [];
    f.service.observeListPerformance = (measurement) => performance.push(measurement);
    const [enriched] = f.service.list({ includeRuns: true, requestId: "request:test" }, f.actor);
    assert.deepEqual(enriched.runs, f.store.listScheduledSessionRuns(created.taskId));
    assert.equal(enriched.runs.length, 1);
    assert.equal(performance[0].requestId, "request:test");
    assert.equal(performance[0].includeRuns, true);
    assert.equal(performance[0].phases.taskQueryMs >= 0, true);
    assert.equal(performance[0].phases.runQueryMs >= 0, true);
    const cancelled = f.service.cancel(created.taskId, f.actor);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(f.service.get(created.taskId, f.actor).events.length >= 3);
  } finally {
    await cleanup(f);
  }
});

test("requires an expiration, supports timestamp and countdown inputs, and defaults to the system time zone", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.createWithoutExpirationDefault({
      logicalSessionId: "logical:stable", message: "missing", scheduleType: "after", delaySeconds: 10
    }, f.actor), (error) => error.code === "INVALID_SCHEDULED_SESSION_TASK"
      && error.field === "expiresAt" && /requires exactly one/.test(error.message));

    assert.throws(() => f.createWithoutDefaults({
      logicalSessionId: "logical:stable", message: "missing title", scheduleType: "after",
      delaySeconds: 10, expiresAfterSeconds: 60
    }, f.actor), (error) => error.code === "INVALID_SCHEDULED_SESSION_TASK"
      && error.field === "name" && /required/.test(error.message));

    const absolute = f.createWithoutExpirationDefault({
      logicalSessionId: "logical:stable", message: "absolute", scheduleType: "after", delaySeconds: 10,
      expiresAt: "2026-08-22T13:00:00+00:00"
    }, f.actor);
    assert.equal(absolute.expiresAt, "2026-08-22T13:00:00.000Z");
    assert.equal(absolute.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

    const countdown = f.createWithoutExpirationDefault({
      logicalSessionId: "logical:stable", message: "countdown", scheduleType: "after", delaySeconds: 10,
      expiresAfterSeconds: 3600, timezone: "Asia/Shanghai"
    }, f.actor);
    assert.equal(countdown.expiresAt, "2026-08-22T13:00:00.000Z");
    assert.equal(countdown.createdAt, "2026-08-22T12:00:00.000Z");
    assert.equal(new Date(countdown.expiresAt) - new Date(countdown.createdAt), 3_600_000);
    assert.equal(f.store.getScheduledSessionTask(countdown.taskId).expiresAt, countdown.expiresAt);
  } finally {
    await cleanup(f);
  }
});

test("expiration is persisted, transitions before trigger evaluation, and permits five task states", async () => {
  let observations = 0;
  const f = await fixture({ evaluateCondition: async () => {
    observations += 1;
    return { state: "matched", exitCode: 0, stdout: "", stderr: "" };
  } });
  try {
    const task = f.createWithoutExpirationDefault({
      logicalSessionId: "logical:stable", message: "do not run", scheduleType: "condition",
      condition: { script: "true" }, expiresAfterSeconds: 10
    }, f.actor);
    f.advance(10_000);
    await f.service.tick();
    const expired = f.store.getScheduledSessionTask(task.taskId);
    assert.equal(expired.status, "expired");
    assert.equal(expired.nextRunAt, null);
    assert.equal(observations, 0);
    assert.equal(f.queued.length, 0);
    assert.equal(f.service.get(task.taskId, f.actor).status, "expired");
    const schema = f.store.selectOne(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_session_tasks'"
    ).sql;
    assert.match(schema, /status IN \('active', 'cancelled', 'completed', 'expired', 'error'\)/);

    await f.store.close();
    const reopened = new CorptieStore({ dbPath: f.dbPath, configPath: join(f.directory, "reopened.json") });
    await reopened.initialize();
    f.store = reopened;
    assert.equal(reopened.getScheduledSessionTask(task.taskId).status, "expired");
    assert.equal(reopened.getScheduledSessionTask(task.taskId).expiresAt, "2026-08-22T12:00:10.000Z");
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
    assert.throws(() => f.service.cancel(once.taskId, f.actor),
      (error) => error.code === "TASK_NOT_MUTABLE");
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
    assert.equal(f.store.getScheduledSessionTask(once.taskId).status, "completed");
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
    const result = f.store.enqueueAgentWorkItemWithResult(work);
    if (throwsAfterInsert) {
      throwsAfterInsert = false;
      const error = new Error("receipt lost");
      error.code = "RECEIPT_LOST";
      throw error;
    }
    return result;
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
    assert.match(work[0].source.deliveryId, /^scheduled_delivery:/);
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "completed");
    assert.equal(f.store.listScheduledSessionEvents(task.taskId)
      .some((event) => event.type === "ScheduledSessionDeliveryDeduplicated"), true);

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

test("a committed one-time delivery timing out downstream never reactivates or redelivers the task", async () => {
  const f = await fixture();
  try {
    const task = f.service.create({
      name: "PolyMarket实时套利，小资金实盘跑通 1 equivalent",
      logicalSessionId: "logical:stable",
      message: "single-cycle acceptance check",
      scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z",
      timeoutSeconds: 1,
      timezone: "UTC"
    }, f.actor);
    f.advance(1_000);
    await f.service.tick();
    let stored = f.store.getScheduledSessionTask(task.taskId);
    assert.equal(stored.status, "completed");
    assert.equal(stored.nextRunAt, null);
    assert.equal(f.queued.length, 1);

    f.advance(1_001);
    await f.service.tick();
    stored = f.store.getScheduledSessionTask(task.taskId);
    assert.equal(stored.status, "completed");
    assert.equal(stored.nextRunAt, null);
    assert.equal(stored.retryCount, 0);
    assert.equal(f.queued.length, 1);
    assert.equal(f.store.listScheduledSessionRuns(task.taskId).length, 1);
    const timeoutEvent = f.store.listScheduledSessionEvents(task.taskId)
      .find((event) => event.payload.retrySuppressed === "delivery_already_committed");
    assert.ok(timeoutEvent);
    assert.equal(timeoutEvent.payload.scheduledFor, "2026-08-22T12:00:01.000Z");
    assert.match(timeoutEvent.payload.deliveryId, /^scheduled:scheduled_delivery:/);

    f.advance(60_000);
    await f.service.tick();
    assert.equal(f.queued.length, 1);
  } finally {
    await cleanup(f);
  }
});

test("concurrent dispatch after a lease expires commits one delivery and records the duplicate", async () => {
  const f = await fixture({ leaseMs: 100 });
  let releaseRoutes;
  const routeGate = new Promise((resolve) => { releaseRoutes = resolve; });
  const route = async (logicalSessionId) => {
    await routeGate;
    const logical = f.store.getLogicalSession(logicalSessionId);
    return { sessionId: logical.legacySessionId, agentId: "agent:owner", binding: logical.activeBinding };
  };
  let attempts = 0;
  let committed = 0;
  const enqueue = (work) => {
    attempts += 1;
    const result = f.store.enqueueAgentWorkItemWithResult(work);
    if (result.inserted) committed += 1;
    return result;
  };
  f.service.resolveRoute = route;
  f.service.enqueue = enqueue;
  const second = new ScheduledSessionTaskService({
    store: f.store,
    environment: "development",
    now: f.service.now,
    leaseOwner: "scheduler:concurrent-second",
    leaseMs: 100,
    missedGraceMs: 2_000,
    authorize: () => ({}),
    resolveRoute: route,
    enqueue
  });
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "concurrent once", scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z", timezone: "UTC"
    }, f.actor);
    f.advance(1_000);
    const firstTick = f.service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    f.advance(101);
    const secondTick = second.tick();
    await new Promise((resolve) => setImmediate(resolve));
    releaseRoutes();
    await Promise.all([firstTick, secondTick]);

    assert.equal(attempts, 2);
    assert.equal(committed, 1);
    const work = f.store.listAgentWorkItemsForSession("session:stable")
      .filter((item) => item.source.scheduledTaskId === task.taskId);
    assert.equal(work.length, 1);
    assert.equal(new Set(work.map((item) => item.source.deliveryId)).size, 1);
    const events = f.store.listScheduledSessionEvents(task.taskId);
    assert.equal(events.filter((event) => event.type === "ScheduledSessionDeliveryCommitted").length, 1);
    assert.equal(events.filter((event) => event.type === "ScheduledSessionDeliveryDeduplicated").length, 1);
  } finally {
    second.stop();
    await cleanup(f);
  }
});

test("identical message actions deduplicate within one run while later interval cycles still deliver", async () => {
  const f = await fixture();
  try {
    const duplicate = f.service.create({
      logicalSessionId: "logical:stable",
      scheduleType: "once",
      runAt: "2026-08-22T12:00:01Z",
      actions: [
        { type: "queueSessionMessage", message: "same message" },
        { type: "queueSessionMessage", message: "same message" }
      ],
      timezone: "UTC"
    }, f.actor);
    const interval = f.service.create({
      logicalSessionId: "logical:stable", message: "next cycle", scheduleType: "interval",
      runAt: "2026-08-22T12:00:01Z", intervalSeconds: 10, timezone: "UTC"
    }, f.actor);
    f.advance(1_000);
    await f.service.tick();
    assert.equal(f.store.listAgentWorkItemsForSession("session:stable")
      .filter((item) => item.source.scheduledTaskId === duplicate.taskId).length, 1);
    const duplicateRun = f.store.listScheduledSessionRuns(duplicate.taskId)[0];
    assert.deepEqual(duplicateRun.actionResults.map((result) => result.status), ["queued", "deduplicated"]);

    const firstCycle = f.store.listAgentWorkItemsForSession("session:stable")
      .find((item) => item.source.scheduledTaskId === interval.taskId);
    assert.ok(firstCycle);
    f.advance(10_000);
    await f.service.tick();
    const intervalWork = f.store.listAgentWorkItemsForSession("session:stable")
      .filter((item) => item.source.scheduledTaskId === interval.taskId);
    assert.equal(intervalWork.length, 2);
    assert.notEqual(intervalWork[0].source.deliveryId, intervalWork[1].source.deliveryId);
    assert.equal(f.store.getScheduledSessionTask(interval.taskId).nextRunAt, "2026-08-22T12:00:21.000Z");
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
      environment: "development", expiresAt: "2026-08-23T12:00:00.000Z"
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
    assert.equal(f.store.getScheduledSessionTask(normal.taskId).status, "completed");
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
      expiresAfterSeconds: 5,
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
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "completed");
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
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "error");
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
    assert.equal(failed.status, "error");
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
    assert.equal(failed.status, "error");
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

test("Automation projection supports after plus ordered message, activation, and local-notification actions", async () => {
  const actionCalls = [];
  const f = await fixture({
    activate: async (value) => actionCalls.push(["activate", value]),
    notify: async (value) => actionCalls.push(["notify", value])
  });
  try {
    const task = f.service.create({
      name: "Follow up",
      logicalSessionId: "logical:stable",
      scheduleType: "after",
      delaySeconds: 2,
      actions: [
        { type: "queueSessionMessage", message: "follow up now" },
        { type: "activateSession" },
        { type: "localNotification", title: "Ready", body: "Follow-up queued" }
      ],
      misfirePolicy: "fireOnce",
      maxConcurrentRuns: 2,
      timeoutSeconds: 60
    }, f.actor);
    assert.equal(task.trigger.type, "after");
    assert.equal(task.trigger.delaySeconds, 2);
    assert.deepEqual(task.actions.map((action) => action.type), [
      "queueSessionMessage", "activateSession", "localNotification"
    ]);
    assert.equal(task.policy.misfire, "fireOnce");
    assert.equal(task.risk.remoteWrite, false);
    f.advance(2_000);
    await f.service.tick();
    const run = f.store.listScheduledSessionRuns(task.taskId)[0];
    assert.equal(run.status, "queued");
    assert.deepEqual(run.actionResults.map((result) => result.status), ["queued", "requested", "requested"]);
    assert.ok(run.stages.some((value) => value.name === "authorization" && value.status === "completed"));
    assert.ok(run.stages.some((value) => value.name === "routing" && value.status === "completed"));
    assert.equal(actionCalls.length, 2);
  } finally {
    await cleanup(f);
  }
});

test("conversation creation defaults to the authenticated Agent's current Logical Session", async () => {
  const f = await fixture();
  try {
    f.service.resolveActorLogicalSessionId = (actor) => {
      assert.deepEqual(actor, f.actor);
      return "logical:stable";
    };
    const task = f.service.create({
      name: "Current conversation follow-up",
      scheduleType: "after",
      delaySeconds: 30,
      message: "Continue here"
    }, f.actor);
    assert.equal(task.logicalSessionId, "logical:stable");
    assert.equal(task.trigger.type, "after");
  } finally {
    await cleanup(f);
  }
});

test("canonical at, interval, processExit, and condition Trigger models persist without Provider fields", async () => {
  const f = await fixture({ inspectProcess: async () => ({
    state: "exited", reason: "process_normal_exit", exitStatus: { kind: "normal", code: 0, signal: null }
  }) });
  try {
    const at = f.service.create({
      logicalSessionId: "logical:stable", message: "at", scheduleType: "at", runAt: "2026-08-22T12:01:00Z"
    }, f.actor);
    const interval = f.service.create({
      logicalSessionId: "logical:stable", message: "interval", scheduleType: "interval", intervalSeconds: 30
    }, f.actor);
    const processExit = f.service.create({
      logicalSessionId: "logical:stable", message: "process", scheduleType: "processExit", process: { pid: 99 }
    }, f.actor);
    const condition = f.service.create({
      logicalSessionId: "logical:stable", message: "condition", scheduleType: "condition", condition: { script: "false" }
    }, f.actor);
    assert.deepEqual([at.trigger.type, interval.trigger.type, processExit.trigger.type, condition.trigger.type], [
      "at", "interval", "processExit", "condition"
    ]);
    for (const task of [at, interval, processExit, condition]) {
      assert.equal(Object.hasOwn(task.trigger, "providerId"), false);
      assert.equal(task.logicalSessionId, "logical:stable");
    }
  } finally {
    await cleanup(f);
  }
});

test("structured condition protocol returns fire/message/state and overrides the queued message", async () => {
  const f = await fixture({
    evaluateCondition: async () => ({
      state: "matched", fire: true, message: "structured wake", observerState: { revision: 7 }, exitCode: 0
    })
  });
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable",
      scheduleType: "condition",
      message: "fallback",
      condition: { script: "printf '{\"fire\":true,\"message\":\"ready\",\"state\":{}}'" }
    }, f.actor);
    await f.service.tick();
    assert.equal(f.queued[0].text, "structured wake");
    assert.deepEqual(f.store.listScheduledSessionRuns(task.taskId)[0].conditionResult.observerState, { revision: 7 });
    const actual = await executeConditionScript({
      script: "printf '{\"fire\":false,\"message\":\"waiting\",\"state\":{\"cursor\":3}}'",
      timeoutSeconds: 3,
      workingDirectory: null
    });
    assert.equal(actual.fire, false);
    assert.equal(actual.message, "waiting");
    assert.deepEqual(actual.observerState, { cursor: 3 });
  } finally {
    await cleanup(f);
  }
});

test("misfire policies support skip, fireOnce, and bounded catchUp", async () => {
  const f = await fixture({ missedGraceMs: 100 });
  try {
    const caught = f.service.create({
      logicalSessionId: "logical:stable", message: "catch up", scheduleType: "interval",
      runAt: "2026-08-22T11:59:50Z", intervalSeconds: 2,
      misfirePolicy: "catchUp", maxCatchUpRuns: 3, backpressureLimit: 10
    }, f.actor);
    await f.service.tick();
    const caughtRuns = f.store.listScheduledSessionRuns(caught.taskId);
    assert.equal(caughtRuns.filter((run) => run.triggerReason === "misfire_catch_up").length, 3);
    assert.ok(new Date(f.store.getScheduledSessionTask(caught.taskId).nextRunAt) > f.service.now());

    const skipped = f.service.create({
      logicalSessionId: "logical:stable", message: "skip", scheduleType: "once",
      runAt: "2026-08-22T11:00:00Z", misfirePolicy: "skip", expiresAfterSeconds: 1
    }, f.actor);
    await f.service.tick();
    assert.equal(f.store.getScheduledSessionTask(skipped.taskId).lastRunStatus, "missed");
    assert.equal(f.store.getScheduledSessionTask(skipped.taskId).status, "active");
    f.advance(1_000);
    await f.service.tick();
    assert.equal(f.store.getScheduledSessionTask(skipped.taskId).status, "expired");

    const fireOnce = f.service.create({
      logicalSessionId: "logical:stable", message: "one", scheduleType: "once",
      runAt: "2026-08-22T11:00:00Z", misfirePolicy: "fireOnce"
    }, f.actor);
    await f.service.tick();
    assert.equal(f.store.listScheduledSessionRuns(fireOnce.taskId).filter((run) => run.status === "queued").length, 1);
    assert.equal(f.store.getScheduledSessionTask(fireOnce.taskId).status, "completed");
  } finally {
    await cleanup(f);
  }
});

test("read-only observer validation rejects remote, destructive, and filesystem-write scripts", async () => {
  const f = await fixture();
  try {
    for (const script of ["curl https://example.com", "rm -f flag", "printf x > flag", "python3 -c 'open(\"x\",\"w\")'"]) {
      assert.throws(() => f.service.create({
        logicalSessionId: "logical:stable", message: "unsafe", scheduleType: "condition",
        condition: { script }
      }, f.actor), (error) => error.code === "INVALID_SCHEDULED_SESSION_TASK");
    }
  } finally {
    await cleanup(f);
  }
});

test("the same provider-neutral Automation contract routes across Codex, Claude, and OpenClacky bindings", async () => {
  const f = await fixture();
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "provider neutral", scheduleType: "interval", intervalSeconds: 60
    }, f.actor);
    const providers = ["codex-app-server", "claude-sdk", "openclacky"];
    const observed = [];
    for (let index = 0; index < providers.length; index += 1) {
      if (index > 0) {
        const logical = f.store.getLogicalSession("logical:stable");
        f.store.beginWorkspaceTransition({
          transitionId: `transition:contract:${index}`,
          logicalSessionId: "logical:stable",
          transitionKind: "provider",
          targetProviderId: providers[index],
          targetCwd: f.directory,
          sourceRoutingVersion: logical.routingVersion,
          phase: "waitingForTurn",
          strategy: "fork"
        });
        f.store.commitWorkspaceTransition(`transition:contract:${index}`, {
          providerThreadId: `provider:${index}`,
          providerSessionId: `provider:${index}`,
          providerId: providers[index],
          boundCwd: f.directory
        });
      }
      const run = await f.service.runNow(task.taskId, f.actor);
      observed.push({
        provider: f.store.getLogicalSession("logical:stable").activeBinding.providerId,
        providerSessionId: run.providerSessionId,
        routingVersion: run.routingVersion
      });
    }
    assert.deepEqual(observed.map((value) => value.provider), providers);
    assert.deepEqual(observed.map((value) => value.routingVersion), [1, 2, 3]);
  } finally {
    await cleanup(f);
  }
});

test("concurrency, backpressure, deadlines, and retry state remain explicit", async () => {
  const f = await fixture();
  try {
    const task = f.service.create({
      logicalSessionId: "logical:stable", message: "bounded", scheduleType: "interval", intervalSeconds: 60,
      maxConcurrentRuns: 1, backpressureLimit: 1, timeoutSeconds: 2
    }, f.actor);
    f.store.createScheduledSessionRun({
      runId: "scheduled_run:running", taskId: task.taskId, runKey: `${task.taskId}:running`,
      scheduledFor: f.service.now().toISOString(), triggerKind: "manual", triggerReason: "fixture",
      status: "running", deadlineAt: "2026-08-22T12:00:10Z"
    });
    await assert.rejects(() => f.service.runNow(task.taskId, f.actor), (error) => error.code === "AUTOMATION_CONCURRENCY_LIMIT");

    f.store.updateScheduledSessionRun("scheduled_run:running", {
      status: "queued", deadlineAt: "2026-08-22T11:59:59Z"
    });
    await f.service.tick();
    const expired = f.store.getScheduledSessionRun("scheduled_run:running");
    assert.equal(expired.status, "failed");
    assert.equal(expired.errorCode, "AUTOMATION_RUN_TIMEOUT");
    assert.equal(f.store.getScheduledSessionTask(task.taskId).status, "active");
    assert.equal(f.store.getScheduledSessionTask(task.taskId).nextRunAt, "2026-08-22T12:01:00.000Z");
    assert.equal(f.store.getScheduledSessionTask(task.taskId).lastRunStatus, "retry_wait");

    const second = f.service.create({
      logicalSessionId: "logical:stable", message: "pressure", scheduleType: "at",
      runAt: "2026-08-22T12:01:00Z", backpressureLimit: 1
    }, f.actor);
    await assert.rejects(() => f.service.runNow(second.taskId, f.actor), (error) => error.code === "AUTOMATION_BACKPRESSURE");
  } finally {
    await cleanup(f);
  }
});
