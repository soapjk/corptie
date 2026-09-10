import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { presentTaskAcceptance } from "../src/application/taskAcceptance.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-scheduled-indicator-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:owner", name: "Owner" });
  const work = store.createWork({
    id: "work:one",
    name: "WorkOne",
    contributorAgentIds: [agent.agentId]
  });
  const task = store.createTask({
    id: "task:one",
    workId: work.id,
    title: "TaskOne",
    mainAgentId: agent.agentId
  });
  const session = store.createSession({
    id: "session:one",
    title: "SessionOne",
    workId: work.id,
    taskId: task.id,
    agentId: agent.agentId,
    sessionKind: "worker",
    status: "complete"
  });
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:one",
    legacySessionId: session.id,
    providerThreadId: "thread:one",
    providerSessionId: "provider:one",
    providerId: "codex-app-server",
    boundCwd: directory,
    sessionName: "SessionOne"
  });
  return { directory, store, task };
}

function createSchedule(store, overrides = {}) {
  return store.createScheduledSessionTask({
    taskId: overrides.taskId ?? "scheduled:one",
    logicalSessionId: "logical:one",
    message: { type: "text", text: "Wake" },
    scheduleType: "once",
    runAt: "2026-09-06T00:00:00.000Z",
    nextRunAt: "2026-09-06T00:00:00.000Z",
    expiresAt: "2026-09-07T00:00:00.000Z",
    intervalSeconds: null,
    timezone: "UTC",
    missedPolicy: "coalesce_once",
    creatorType: "agent",
    creatorId: "agent:owner",
    environment: "development",
    ...overrides
  });
}

test("Chat wake indicator needs no Task and publishes cancellation to the Session", async () => {
  const f = await fixture();
  try {
    const options = { environment: "development", now: "2026-09-05T00:00:00.000Z" };
    for (const kind of ["assistantChat", "workChat"]) {
      const id = `session:${kind}`;
      const logicalSessionId = `logical:${kind}`;
      f.store.createSession({ id, title: kind, sessionKind: kind, status: "complete",
        workId: kind === "workChat" ? "work:one" : null, agentId: "agent:owner" });
      f.store.createLogicalSessionRoute({ logicalSessionId, legacySessionId: id,
        providerId: "test-provider", providerThreadId: id, providerSessionId: id,
        boundCwd: f.directory, sessionName: kind });
      const revision = f.store.stateRevision();
      createSchedule(f.store, { taskId: `schedule:${kind}`, logicalSessionId });
      assert.ok(f.store.listSessionIdsWithPendingScheduledWake(options).includes(id));
      assert.deepEqual(f.store.stateChangesAfter(revision).map(c => [c.entityType, c.entityId]), [["session", id]]);
      assert.equal(f.store.listSessionIdsWithPendingScheduledWake({ ...options, environment: "production" }).includes(id), false);
      f.store.updateScheduledSessionTask(`schedule:${kind}`, { status: "cancelled", nextRunAt: null });
      assert.equal(f.store.listSessionIdsWithPendingScheduledWake(options).includes(id), false);
      for (const status of ["completed", "error", "expired"]) {
        createSchedule(f.store, { taskId: `schedule:${kind}:${status}`, logicalSessionId, status });
        f.store.updateScheduledSessionTask(`schedule:${kind}:${status}`, { status });
      }
      createSchedule(f.store, { taskId: `schedule:${kind}:past-expiry`, logicalSessionId, expiresAt: options.now });
      createSchedule(f.store, { taskId: `schedule:${kind}:consumed`, logicalSessionId, nextRunAt: null });
      assert.equal(f.store.listSessionIdsWithPendingScheduledWake(options).includes(id), false);
    }
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Task scheduled-wake projection only exposes active unexpired pending plans", async () => {
  const f = await fixture();
  try {
    const now = "2026-09-05T00:00:00.000Z";
    const revision = f.store.stateRevision();
    createSchedule(f.store);

    assert.deepEqual(f.store.listTaskIdsWithPendingScheduledWake({
      environment: "development", now
    }), [f.task.id]);
    assert.equal(f.store.hasPendingScheduledWakeForTask(f.task.id, {
      environment: "development", now
    }), true);
    assert.equal(presentTaskAcceptance(f.store.getTask(f.task.id), {
      hasPendingScheduledWake: true
    }).hasPendingScheduledWake, true);
    assert.deepEqual(
      f.store.stateChangesAfter(revision).map((change) => [change.entityType, change.entityId]),
      [["session", "session:one"], ["task", f.task.id]]
    );

    f.store.updateScheduledSessionTask("scheduled:one", {
      status: "cancelled",
      nextRunAt: null
    });
    assert.equal(f.store.hasPendingScheduledWakeForTask(f.task.id, {
      environment: "development", now
    }), false);

    createSchedule(f.store, {
      taskId: "scheduled:completed",
      nextRunAt: null
    });
    createSchedule(f.store, {
      taskId: "scheduled:expired",
      nextRunAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2026-09-04T12:00:00.000Z"
    });
    assert.equal(f.store.hasPendingScheduledWakeForTask(f.task.id, {
      environment: "development", now
    }), false);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("one remaining pending plan keeps the Task indicator visible", async () => {
  const f = await fixture();
  try {
    const options = { environment: "development", now: "2026-09-05T00:00:00.000Z" };
    createSchedule(f.store, { taskId: "scheduled:first" });
    createSchedule(f.store, {
      taskId: "scheduled:second",
      nextRunAt: "2026-09-06T01:00:00.000Z"
    });
    f.store.updateScheduledSessionTask("scheduled:first", {
      status: "error",
      nextRunAt: null
    });
    assert.equal(f.store.hasPendingScheduledWakeForTask(f.task.id, options), true);
    f.store.updateScheduledSessionTask("scheduled:second", {
      status: "completed",
      nextRunAt: null
    });
    assert.equal(f.store.hasPendingScheduledWakeForTask(f.task.id, options), false);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
