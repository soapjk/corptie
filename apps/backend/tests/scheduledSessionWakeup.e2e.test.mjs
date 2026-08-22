import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScheduledSessionTaskService } from "../src/application/scheduledSessionTaskService.mjs";
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
    store.enqueueAgentWorkItem({
      workItemId: "work:original-turn",
      agentId: "agent:e2e",
      sessionId: "session:e2e",
      kind: "user",
      priority: 100,
      text: "original turn",
      source: { type: "test" },
      createdAt: new Date().toISOString()
    });
    store.claimAgentWorkItem("work:original-turn");
    store.updateAgentWorkItem("work:original-turn", { targetTurnId: "turn:original" });

    let resolveCompleted;
    const completed = new Promise((resolve) => { resolveCompleted = resolve; });
    const drain = () => {
      if (store.getRunningAgentWorkItemForSession("session:e2e")) return;
      const next = store.listQueuedAgentWorkItemsForSession("session:e2e", 1)[0];
      if (!next) return;
      const claimed = store.claimAgentWorkItem(next.workItemId);
      if (!claimed) return;
      const started = store.updateAgentWorkItem(claimed.workItemId, { targetTurnId: "turn:scheduled-wakeup" });
      service.handleAgentWorkEvent("AgentWorkStarted", started);
      const finished = store.updateAgentWorkItem(claimed.workItemId, { status: "completed" });
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
      resolveRoute: async () => {
        const logical = store.getLogicalSession("logical:e2e");
        return {
          sessionId: logical.legacySessionId,
          agentId: "agent:e2e",
          binding: logical.activeBinding
        };
      },
      enqueue: (work) => {
        const queued = store.enqueueAgentWorkItem(work);
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
        message: { text: "check and return status", payload: { check: "status" } },
        scheduleType: "once",
        runAt,
        timezone: "Asia/Shanghai"
      })
    });
    assert.equal(response.status, 201);
    const task = (await response.json()).task;

    await new Promise((resolve) => setTimeout(resolve, 30));
    // Under a loaded test runner the due tick may already have happened. In
    // either timing, the durable queue must leave the original Turn running
    // and keep the wakeup queued instead of interrupting it.
    assert.equal(store.getRunningAgentWorkItemForSession("session:e2e").workItemId, "work:original-turn");
    assert.equal(store.listQueuedAgentWorkItemsForSession("session:e2e")
      .every((item) => item.source.type === "scheduled_session_task"), true);
    store.updateAgentWorkItem("work:original-turn", { status: "completed" });
    drain();

    const finished = await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("scheduled wakeup timed out")), 2_000))
    ]);
    assert.equal(finished.sessionId, "session:e2e");
    assert.equal(finished.targetTurnId, "turn:scheduled-wakeup");
    assert.equal(finished.source.scheduledTaskId, task.taskId);
    assert.equal(finished.source.payload.check, "status");
    const run = store.listScheduledSessionRuns(task.taskId).find((candidate) => candidate.agentWorkItemId === finished.workItemId);
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
