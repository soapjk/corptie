import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverCollaborationDeliveriesAfterCodexRolloutRepair } from "../src/application/collaborationDeliveryInfrastructureRecovery.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { CollaborationDeliveryDispatcher } from "../src/collaboration/collaborationDeliveryDispatcher.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-infrastructure-recovery-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  let ordinal = 0;
  const core = new CollaborationCore(store, {
    idFactory: () => `recovery-${++ordinal}`,
    clock: () => "2026-08-28T09:00:00.000Z"
  });
  core.registerAgent({ agentId: "agent-a", name: "Agent A" });
  core.registerAgent({ agentId: "agent-b", name: "Agent B" });
  const work = store.createWork({
    id: "work:recovery",
    name: "Recovery",
    contributorAgentIds: ["agent-a", "agent-b"]
  });
  const sourceTask = store.createTask({
    id: "task:source",
    workId: work.id,
    title: "Source",
    mainAgentId: "agent-a"
  });
  const targetTask = store.createTask({
    id: "task:target",
    workId: work.id,
    title: "Target",
    mainAgentId: "agent-b"
  });
  for (const [providerSessionId, logicalSessionId, agentId, taskId] of [
    ["codex:thread-a", "session:thread-a", "agent-a", sourceTask.id],
    ["codex:thread-b", "session:thread-b", "agent-b", targetTask.id]
  ]) {
    store.createSession({
      id: providerSessionId,
      title: providerSessionId,
      agentId,
      sessionKind: "worker",
      workId: work.id,
      taskId,
      cwd: directory
    });
    store.createLogicalSessionRoute({
      logicalSessionId,
      legacySessionId: providerSessionId,
      providerThreadId: providerSessionId,
      providerSessionId,
      providerId: "codex-app-server",
      boundCwd: directory,
      sessionName: providerSessionId
    });
  }
  core.bindSession({ agentId: "agent-a", sessionId: "codex:thread-a" });
  core.bindSession({ agentId: "agent-b", sessionId: "codex:thread-b" });
  const task = core.createTask({
    initiatorAgentId: "agent-a",
    recipientAgentId: "agent-b",
    initiatorSessionId: "session:thread-a",
    recipientSessionId: "session:thread-b",
    type: "change_request",
    title: "Recover delivery",
    summary: "Process the persisted collaboration payload",
    idempotencyKey: "recover-delivery"
  });
  const delivery = core.listPendingDeliveries()[0];
  const missingRolloutError = "failed to resolve rollout path `/old/sessions/rollout-thread-b.jsonl`: file does not exist";
  core.updateDelivery(delivery.deliveryId, {
    status: "failed",
    incrementAttempt: true,
    nextAttemptAt: null,
    lastError: missingRolloutError
  });
  core.updateDelivery(delivery.deliveryId, { incrementAttempt: true });
  core.updateDelivery(delivery.deliveryId, { incrementAttempt: true });
  store.enqueueAgentTask({
    taskId: `delivery:${delivery.deliveryId}`,
    agentId: "agent-b",
    sessionId: "codex:thread-b",
    kind: "collaboration",
    priority: 50,
    text: "trusted persisted payload",
    source: { type: "collaboration", deliveryId: delivery.deliveryId },
    deliveryId: delivery.deliveryId
  });
  store.updateAgentTask(`delivery:${delivery.deliveryId}`, {
    status: "failed",
    lastError: missingRolloutError
  });
  return { directory, store, core, task, delivery };
}

test("a repaired rollout requeues the exhausted delivery and existing Agent Work exactly once", async () => {
  const value = await fixture();
  try {
    const logs = [];
    const options = {
      core: value.core,
      store: value.store,
      rolloutPathRepair: { repairs: [{ id: "thread-b" }] },
      logger: { warn: (message) => logs.push(message) }
    };
    const recovered = recoverCollaborationDeliveriesAfterCodexRolloutRepair(options);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].delivery.deliveryId, value.delivery.deliveryId);
    assert.equal(recovered[0].delivery.status, "pending");
    assert.equal(recovered[0].delivery.attemptCount, 0);
    assert.equal(value.core.listPendingDeliveries(100, 3).length, 1);
    const work = value.store.getAgentTaskForDelivery(value.delivery.deliveryId);
    assert.equal(work.status, "queued");
    assert.equal(work.taskId, `delivery:${value.delivery.deliveryId}`);
    assert.match(logs[0], new RegExp(`deliveryId=${value.delivery.deliveryId}`));
    assert.equal(value.core.getTask(value.task.taskId).events.at(-1).type, "delivery_recovered");

    const turns = [];
    const dispatcher = new CollaborationDeliveryDispatcher({
      core: value.core,
      runtime: {
        async inspect() { return "idle"; },
        async startTurn(sessionId, text, metadata) {
          turns.push({ sessionId, text, metadata });
          return { turnId: "turn:recovered" };
        }
      }
    });
    const delivered = await dispatcher.dispatch(value.delivery.deliveryId);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.targetTurnId, "turn:recovered");
    assert.equal(turns[0].sessionId, "codex:thread-b");
    assert.equal(turns[0].metadata.deliveryId, value.delivery.deliveryId);
    assert.match(turns[0].text, /Process the persisted collaboration payload/);
    await dispatcher.dispatch(value.delivery.deliveryId);
    assert.equal(turns.length, 1);
    assert.equal(value.core.getTask(value.task.taskId).events.at(-1).type, "delivery_succeeded");

    assert.deepEqual(recoverCollaborationDeliveriesAfterCodexRolloutRepair(options), []);
    assert.equal(value.store.getAgentTaskForDelivery(value.delivery.deliveryId).taskId, work.taskId);
  } finally {
    if (value.store.saveTimer) clearTimeout(value.store.saveTimer);
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("recovery fails closed for unrelated errors and unrepaired threads", async () => {
  const value = await fixture();
  try {
    value.store.updateAgentTask(`delivery:${value.delivery.deliveryId}`, {
      lastError: "failed to resolve rollout path `/old/file`: permission denied"
    });
    assert.deepEqual(recoverCollaborationDeliveriesAfterCodexRolloutRepair({
      core: value.core,
      store: value.store,
      rolloutPathRepair: { repairs: [{ id: "thread-b" }] },
      logger: { warn() {} }
    }), []);
    assert.equal(value.core.getDelivery(value.delivery.deliveryId).attemptCount, 3);

    value.store.updateAgentTask(`delivery:${value.delivery.deliveryId}`, {
      lastError: "failed to resolve rollout path `/old/sessions/rollout-thread-b.jsonl`: file does not exist"
    });
    assert.deepEqual(recoverCollaborationDeliveriesAfterCodexRolloutRepair({
      core: value.core,
      store: value.store,
      rolloutPathRepair: { repairs: [{ id: "another-thread" }] },
      logger: { warn() {} }
    }), []);
  } finally {
    if (value.store.saveTimer) clearTimeout(value.store.saveTimer);
    await rm(value.directory, { recursive: true, force: true });
  }
});
