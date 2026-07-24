import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function createFixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-collaboration-test-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  await store.initialize();
  let sequence = 0;
  const core = new CollaborationCore(store, {
    idFactory: () => `generated-${++sequence}`,
    clock: () => `2026-07-17T00:00:${String(sequence).padStart(2, "0")}.000Z`
  });
  return { directory, dbPath, store, core };
}

function seedAgentsAndService(core) {
  core.registerAgent({
    agentId: "research-agent",
    name: "Research Agent",
    capabilities: ["research", "research"]
  });
  core.registerAgent({
    agentId: "journal-agent",
    name: "Journal Agent",
    capabilities: ["investment-journal"]
  });
  core.registerService({
    serviceId: "investment-journal",
    name: "Investment Journal",
    ownerAgentId: "journal-agent",
    currentVersion: "1.3.0",
    status: "running",
    endpoint: "local://investment-journal"
  });
}

function newTask(core, overrides = {}) {
  return core.createTask({
    initiatorAgentId: "research-agent",
    recipientAgentId: "journal-agent",
    serviceId: "investment-journal",
    type: "change_request",
    title: "Completion notification is stale",
    summary: "The notification remains in processing state.",
    acceptanceCriteria: ["Completed sessions show completed", "Do not complete early"],
    evidence: [{ type: "log", uri: "local-artifact://session.log" }],
    ...overrides
  });
}

async function withFixture(run) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    if (fixture.store.saveTimer) clearTimeout(fixture.store.saveTimer);
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

test("Phase 1 migration creates every collaboration table", async () => {
  await withFixture(async ({ store }) => {
    const names = store.selectAll(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).map((row) => row.name);
    for (const table of [
      "agents",
      "agent_sessions",
      "services",
      "service_consumers",
      "collaboration_contexts",
      "collaboration_tasks",
      "collaboration_request_confirmations",
      "collaboration_participants",
      "collaboration_messages",
      "collaboration_artifacts",
      "collaboration_deliveries",
      "collaboration_events",
      "agent_work_items"
    ]) {
      assert.ok(names.includes(table), `missing ${table}`);
    }
  });
});

test("a staged request creates no task until deterministic user confirmation", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    core.bindSession({ agentId: "research-agent", sessionId: "codex:research" });
    const confirmation = core.proposeTask({
      initiatorAgentId: "research-agent",
      recipientAgentId: "journal-agent",
      sourceTurnId: "turn-1",
      serviceId: "investment-journal",
      type: "change_request",
      title: "Fix stale status",
      summary: "Completion still shows processing.",
      acceptanceCriteria: ["Show completed after the run finishes"]
    });

    assert.equal(confirmation.status, "pending");
    assert.equal(confirmation.recipientAgentName, "Journal Agent");
    assert.equal(confirmation.sourceSessionId, "codex:research");
    assert.equal(confirmation.sourceTurnId, "turn-1");
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_deliveries").length, 0);

    const resolved = core.confirmTaskConfirmation(confirmation.confirmationId);
    assert.equal(resolved.status, "confirmed");
    assert.ok(resolved.taskId);
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 1);
    assert.equal(store.selectAll("SELECT * FROM collaboration_deliveries").length, 1);
    assert.equal(core.confirmTaskConfirmation(confirmation.confirmationId).taskId, resolved.taskId);
  });
});

test("rejecting a staged request never creates a task or delivery", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    const confirmation = core.proposeTask({
      initiatorAgentId: "research-agent",
      recipientAgentId: "journal-agent",
      type: "question",
      title: "Ask status",
      summary: "Reply with current status."
    });
    const rejected = core.rejectTaskConfirmation(confirmation.confirmationId);
    assert.equal(rejected.status, "rejected");
    assert.equal(store.selectAll("SELECT * FROM collaboration_tasks").length, 0);
    assert.equal(store.selectAll("SELECT * FROM collaboration_deliveries").length, 0);
  });
});

test("agent identity survives session replacement and a session has one current owner", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    core.bindSession({ agentId: "research-agent", sessionId: "codex:old-thread" });
    core.bindSession({ agentId: "research-agent", sessionId: "codex:new-thread" });

    assert.equal(core.getAgent("research-agent").currentSessionId, "codex:new-thread");
    const bindings = store.selectAll(
      "SELECT session_id, unbound_at FROM agent_sessions WHERE agent_id = ? ORDER BY bound_at ASC, session_id ASC",
      ["research-agent"]
    );
    assert.equal(bindings.length, 2);
    assert.ok(bindings.find((row) => row.session_id === "codex:old-thread").unbound_at);
    assert.equal(bindings.find((row) => row.session_id === "codex:new-thread").unbound_at, null);

    assert.throws(
      () => core.bindSession({ agentId: "journal-agent", sessionId: "codex:new-thread" }),
      (error) => error.code === "SESSION_ALREADY_BOUND"
    );
  });
});

test("deleting a Session deactivates its Agent while preserving collaboration history", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    store.upsertSession({
      id: "codex:temporary-thread",
      title: "Research Agent",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    core.bindSession({ agentId: "research-agent", sessionId: "codex:temporary-thread" });
    const task = newTask(core);

    const deactivated = core.deactivateAgentForSession("codex:temporary-thread");
    store.deleteSession("codex:temporary-thread");

    assert.equal(deactivated.status, "inactive");
    assert.equal(deactivated.currentSessionId, null);
    assert.equal(core.getTask(task.taskId).initiatorAgentId, "research-agent");
    const binding = store.selectOne(
      "SELECT unbound_at FROM agent_sessions WHERE agent_id = ? AND session_id = ?",
      ["research-agent", "codex:temporary-thread"]
    );
    assert.ok(binding.unbound_at);
  });
});

test("startup reconciliation deactivates Agents bound to already deleted Sessions", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    core.bindSession({ agentId: "research-agent", sessionId: "codex:missing-thread" });

    const deactivated = core.deactivateAgentsWithMissingSessions();

    assert.deepEqual(deactivated.map((agent) => agent.agentId), ["research-agent"]);
    assert.equal(core.getAgent("research-agent").status, "inactive");
    assert.equal(core.getAgent("research-agent").currentSessionId, null);
    assert.ok(store.selectOne(
      "SELECT unbound_at FROM agent_sessions WHERE agent_id = ? AND session_id = ?",
      ["research-agent", "codex:missing-thread"]
    ).unbound_at);
    assert.deepEqual(core.deactivateAgentsWithMissingSessions(), []);
  });
});

test("service requests must target the owner and ownership cannot be silently transferred", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    assert.throws(
      () => core.registerService({
        serviceId: "investment-journal",
        name: "Investment Journal",
        ownerAgentId: "research-agent"
      }),
      (error) => error.code === "SERVICE_OWNER_MISMATCH"
    );
    assert.throws(
      () => core.createTask({
        initiatorAgentId: "journal-agent",
        recipientAgentId: "research-agent",
        serviceId: "investment-journal",
        title: "Wrong owner",
        summary: "This must be rejected."
      }),
      (error) => error.code === "RECIPIENT_NOT_SERVICE_OWNER"
    );
    assert.throws(
      () => core.updateService("investment-journal", "research-agent", { currentVersion: "9.9.9" }),
      (error) => error.code === "SERVICE_OWNER_REQUIRED"
    );
    assert.equal(
      core.updateService("investment-journal", "journal-agent", { currentVersion: "1.3.1" }).currentVersion,
      "1.3.1"
    );
  });
});

test("task creation is idempotent and atomically creates message, delivery, participants and event", async () => {
  await withFixture(async ({ core, store }) => {
    seedAgentsAndService(core);
    const first = newTask(core, { idempotencyKey: "request-42" });
    const second = newTask(core, { idempotencyKey: "request-42" });

    assert.equal(second.taskId, first.taskId);
    assert.equal(first.status, "proposed");
    assert.deepEqual(first.acceptanceCriteria, ["Completed sessions show completed", "Do not complete early"]);
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].messageType, "change_request");
    assert.equal(first.events.length, 1);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM collaboration_deliveries").count, 1);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM collaboration_participants").count, 2);

    const [delivery] = core.listPendingDeliveries();
    const delivered = core.updateDelivery(delivery.deliveryId, {
      status: "delivered",
      incrementAttempt: true,
      targetTurnId: "turn-1"
    });
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attemptCount, 1);
    assert.equal(delivered.targetTurnId, "turn-1");
  });
});

test("clarification and delivery follow role-based state transitions", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    let task = newTask(core);
    task = core.askForInformation(task.taskId, "journal-agent", "Please attach a trace.");
    assert.equal(task.status, "needs_information");
    assert.equal(task.messages.at(-1).messageType, "needs_information");
    task = core.replyWithInformation(task.taskId, "research-agent", "Trace attached.", {
      evidence: [{ type: "log", uri: "local-artifact://trace.txt" }]
    });
    assert.equal(task.status, "proposed");
    task = core.accept(task.taskId, "journal-agent");
    task = core.startWorking(task.taskId, "journal-agent");

    assert.throws(
      () => core.submitResult(task.taskId, "research-agent", {
        body: "Unauthorized release",
        artifact: { type: "service_release", name: "bad", uri: "local://bad" }
      }),
      (error) => error.code === "ACTOR_NOT_AUTHORIZED"
    );

    task = core.submitResult(task.taskId, "journal-agent", {
      body: "Version 1.3.1 is ready.",
      artifact: {
        artifactId: "release-1.3.1",
        type: "service_release",
        name: "Investment Journal 1.3.1",
        uri: "local-service://investment-journal/1.3.1",
        metadata: { version: "1.3.1", testStatus: "passed" }
      }
    });
    assert.equal(task.status, "delivered");
    assert.equal(task.artifacts.length, 1);
    task = core.beginVerification(task.taskId, "research-agent");
    task = core.complete(task.taskId, "research-agent", "All acceptance criteria passed.");
    assert.equal(task.status, "completed");
    assert.ok(task.completedAt);
    assert.deepEqual(task.events.map((event) => event.sequence), task.events.map((_, index) => index + 1));
  });
});

test("a third failed verification escalates instead of starting an unbounded fourth iteration", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    let task = newTask(core, { maxIterations: 3 });
    task = core.accept(task.taskId, "journal-agent");

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      task = core.startWorking(task.taskId, "journal-agent");
      task = core.submitResult(task.taskId, "journal-agent", {
        body: `Iteration ${iteration} is ready.`,
        artifact: {
          artifactId: `release-${iteration}`,
          type: "service_release",
          name: `Release ${iteration}`,
          uri: `local-service://investment-journal/iteration-${iteration}`,
          metadata: { version: `1.3.${iteration}` }
        }
      });
      task = core.beginVerification(task.taskId, "research-agent");
      task = core.requestRevision(task.taskId, "research-agent", `Iteration ${iteration} failed verification.`);
    }

    assert.equal(task.status, "escalated");
    assert.equal(task.iteration, 3);
    assert.equal(task.events.at(-1).type, "iteration_limit_reached");
    assert.throws(
      () => core.startWorking(task.taskId, "journal-agent"),
      (error) => error.code === "INVALID_TASK_TRANSITION"
    );
  });
});

test("a question answer completes the task and initiators cannot reuse it for a new question", async () => {
  await withFixture(async ({ core }) => {
    seedAgentsAndService(core);
    let task = core.createTask({
      initiatorAgentId: "research-agent",
      recipientAgentId: "journal-agent",
      type: "question",
      title: "Return ready",
      summary: "Reply with exactly ready.",
      acceptanceCriteria: ["The reply is exactly ready"]
    });
    task = core.accept(task.taskId, "journal-agent");
    task = core.startWorking(task.taskId, "journal-agent");

    assert.throws(
      () => core.reply(task.taskId, "research-agent", "Reply with OK instead."),
      (error) => error.code === "QUESTION_FOLLOWUP_REQUIRES_NEW_TASK"
    );

    task = core.reply(task.taskId, "journal-agent", "ready");
    assert.equal(task.status, "completed");
    assert.ok(task.completedAt);
    assert.equal(task.messages.at(-1).body, "ready");
    assert.equal(task.events.at(-1).type, "question_answered");
    assert.throws(
      () => core.reply(task.taskId, "research-agent", "Another question"),
      (error) => error.code === "TASK_TERMINAL"
    );
  });
});

test("agents, task history and pending delivery survive a database restart", async () => {
  await withFixture(async ({ directory, dbPath, core, store }) => {
    seedAgentsAndService(core);
    const task = newTask(core);
    await store.save();
    if (store.saveTimer) {
      clearTimeout(store.saveTimer);
      store.saveTimer = null;
    }

    const reopenedStore = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await reopenedStore.initialize();
    const reopened = new CollaborationCore(reopenedStore);
    assert.equal(reopened.getAgent("research-agent").name, "Research Agent");
    assert.equal(reopened.getTask(task.taskId).messages.length, 1);
    assert.equal(reopened.listPendingDeliveries().length, 1);
    if (reopenedStore.saveTimer) clearTimeout(reopenedStore.saveTimer);
  });
});
