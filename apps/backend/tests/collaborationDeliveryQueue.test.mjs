import test from "node:test";
import assert from "node:assert/strict";
import { createCollaborationDeliveryQueue } from "../src/collaboration/collaborationDeliveryQueue.mjs";

function fixture({ existing = null, missingEnvelope = false } = {}) {
  const calls = [];
  const delivery = { deliveryId: "delivery-1", recipientAgentId: "agent-1", status: "pending", createdAt: "now" };
  const envelope = {
    delivery,
    channel: { channelId: "channel-1" },
    task: { taskId: "task-1", recipientSessionId: "logical-new", routingVersion: 2 },
    message: { messageId: "message-1", senderSessionId: "logical-sender", recipientSessionId: "logical-new", body: "hello", messageKind: "message" }
  };
  const route = { providerSessionId: "provider-new", sessionId: "logical-new" };
  const deliveryService = {
    listPendingDeliveries: () => [delivery],
    listQueuedDeliveries: () => [],
    getDeliveryEnvelope: () => missingEnvelope ? null : envelope,
    updateDelivery: (...args) => calls.push(["delivery", ...args]),
    resolveDeliveryRoute: () => route,
    getAgentForSession: () => ({ agentId: "agent-1" }),
    getAgent: () => ({ agentId: "agent-1", name: "Agent" }),
    recordDeliveryEvent: (...args) => calls.push(["record", ...args])
  };
  const queue = createCollaborationDeliveryQueue({
    store: {
      getAgentTaskForDelivery: () => existing,
      updateAgentTask: (...args) => calls.push(["update", ...args]),
      enqueueAgentTask: (task) => { calls.push(["enqueue", task]); return task; }
    },
    sessionChannelService: deliveryService,
    collaborationCore: deliveryService,
    collaborationDispatcher: { maxAttempts: 3, failRoute: (...args) => calls.push(["fail", ...args]) },
    collaborationDeliveryRouteResolver: { resolve: async () => route },
    registerRuntimeQueuedWork: (...args) => calls.push(["register", ...args]),
    moveRuntimeQueuedWork: (...args) => calls.push(["move", ...args]),
    scheduleAgentWorkDrain: (...args) => calls.push(["drain", ...args]),
    emitEvent: (...args) => calls.push(["event", ...args])
  });
  return { queue, calls };
}

test("channel delivery retains Session identities and registers before dispatch", async () => {
  const { queue, calls } = fixture();
  await queue.syncSessionChannelDeliveriesIntoAgentWorkQueue();
  const task = calls.find(([kind]) => kind === "enqueue")[1];
  assert.equal(task.sessionId, "provider-new");
  assert.equal(task.source.recipientSessionId, "logical-new");
  assert.equal(task.source.senderSessionId, "logical-sender");
  assert.equal(task.channelDeliveryId, "delivery-1");
  assert.equal(task.localVisibility, "status_only");
  assert.deepEqual(calls.map(([kind]) => kind), ["enqueue", "register", "delivery", "event", "drain"]);
});

test("collaboration retry moves existing queued work to the current route", async () => {
  const { queue, calls } = fixture({ existing: {
    taskId: "existing", status: "queued", sessionId: "provider-old", source: { messageId: "message-1" }
  } });
  await queue.syncCollaborationDeliveriesIntoAgentWorkQueue();
  assert.deepEqual(calls.map(([kind]) => kind), ["update", "move", "drain"]);
  assert.equal(calls[0][2].source.recipientSessionId, "logical-new");
  assert.equal(calls[0][2].source.messageId, "message-1");
  assert.deepEqual(calls[1], ["move", "provider-old", "provider-new", "existing"]);
});

test("already running work is not duplicated or restarted", async () => {
  const { queue, calls } = fixture({ existing: { taskId: "existing", status: "running", sessionId: "provider-old" } });
  await queue.syncCollaborationDeliveriesIntoAgentWorkQueue();
  await queue.syncSessionChannelDeliveriesIntoAgentWorkQueue();
  assert.deepEqual(calls, []);
});

test("missing envelopes fail durably without scheduling execution", async () => {
  const { queue, calls } = fixture({ missingEnvelope: true });
  await queue.syncCollaborationDeliveriesIntoAgentWorkQueue();
  await queue.syncSessionChannelDeliveriesIntoAgentWorkQueue();
  assert.deepEqual(calls.map(([kind]) => kind), ["fail", "delivery"]);
  assert.equal(calls[0][2].code, "COLLABORATION_ENVELOPE_MISSING");
  assert.equal(calls[1][2].status, "failed");
  assert.equal(calls[1][2].incrementAttempt, true);
});
