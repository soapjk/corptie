import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScheduledSessionTaskService } from "../src/application/scheduledSessionTaskService.mjs";
import { createScheduledSessionRouteResolver } from "../src/application/scheduledSessionRoute.mjs";
import { handleScheduledSessionTaskHttpRequest } from "../src/application/scheduledSessionTaskHttpApi.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("short-delay HTTP schedule wakes the same logical Session in a new queued Turn after its original Turn settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-scheduled-wakeup-e2e-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  let server;
  let service;
  try {
    await store.initialize();
    store.upsertSession({
      id: "session:e2e", title: "E2E", agent: "Test Provider",
      provider: "test-provider", status: "running"
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:e2e",
      legacySessionId: "session:e2e",
      providerThreadId: "test-thread:binding",
      providerSessionId: "test-thread:binding",
      providerId: "test-provider",
      boundCwd: directory,
      title: "E2E"
    });
    const core = new CollaborationCore(store);
    core.registerAgent({ agentId: "agent:e2e", name: "E2E Agent" });
    core.bindSession({ agentId: "agent:e2e", sessionId: "session:e2e" });
    store.enqueueAgentTask({
      taskId: "work:original-turn",
      agentId: "agent:e2e",
      sessionId: "session:e2e",
      kind: "user",
      priority: 100,
      text: "original turn",
      source: { type: "test" },
      createdAt: new Date().toISOString()
    });
    store.claimAgentTask("work:original-turn");
    store.updateAgentTask("work:original-turn", { targetTurnId: "turn:original" });

    let resolveCompleted;
    const completed = new Promise((resolve) => { resolveCompleted = resolve; });
    const drain = () => {
      if (store.getRunningAgentTaskForSession("session:e2e")) return;
      const next = store.listQueuedAgentTasksForSession("session:e2e", 1)[0];
      if (!next) return;
      const claimed = store.claimAgentTask(next.taskId);
      if (!claimed) return;
      const started = store.updateAgentTask(claimed.taskId, { targetTurnId: "turn:scheduled-wakeup" });
      service.handleAgentWorkEvent("AgentWorkStarted", started);
      const finished = store.updateAgentTask(claimed.taskId, { status: "completed" });
      service.handleAgentWorkEvent("AgentWorkCompleted", finished);
      resolveCompleted(finished);
    };
    service = new ScheduledSessionTaskService({
      store,
      environment: "development",
      tickMs: 10,
      missedGraceMs: 500,
      authorize: ({ actor, logicalSessionId }) => {
        assert.equal(actor.id, "user:e2e");
        assert.equal(logicalSessionId, "logical:e2e");
        return {};
      },
      resolveRoute: createScheduledSessionRouteResolver({ store, collaborationCore: core }),
      enqueue: (work) => {
        const queued = store.enqueueAgentTask(work);
        setImmediate(drain);
        return queued;
      }
    });
    server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      handleScheduledSessionTaskHttpRequest({
        request,
        response,
        url,
        service,
        resolveActor: () => ({ type: "user", id: "user:e2e" })
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    service.start();

    const runAt = new Date(Date.now() + 80).toISOString();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/scheduled-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logicalSessionId: "logical:e2e",
        name: "Check status",
        message: { text: "check and return status", payload: { check: "status" } },
        scheduleType: "once",
        runAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        timezone: "Asia/Shanghai"
      })
    });
    assert.equal(response.status, 201);
    const task = (await response.json()).task;

    await new Promise((resolve) => setTimeout(resolve, 30));
    // Under a loaded test runner the due tick may already have happened. In
    // either timing, the durable queue must leave the original Turn running
    // and keep the wakeup queued instead of interrupting it.
    assert.equal(store.getRunningAgentTaskForSession("session:e2e").taskId, "work:original-turn");
    assert.equal(store.listQueuedAgentTasksForSession("session:e2e")
      .every((item) => item.source.type === "scheduled_session_task"), true);
    store.updateAgentTask("work:original-turn", { status: "completed" });
    drain();

    const finished = await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("scheduled wakeup timed out")), 2_000))
    ]);
    assert.equal(finished.sessionId, "session:e2e");
    assert.equal(finished.targetTurnId, "turn:scheduled-wakeup");
    assert.equal(finished.source.scheduledTaskId, task.taskId);
    assert.equal(finished.source.payload.check, "status");
    const run = store.listScheduledSessionRuns(task.taskId).find((candidate) => candidate.agentTaskId === finished.taskId);
    assert.equal(run.status, "completed");
    assert.equal(run.targetTurnId, "turn:scheduled-wakeup");
    assert.equal(store.getScheduledSessionTask(task.taskId).lastRunStatus, "completed");
  } finally {
    service?.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
