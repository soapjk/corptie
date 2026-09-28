import test from "node:test";
import assert from "node:assert/strict";
import { CollaborationDeliveryReader } from "../src/collaboration/collaborationDeliveryReader.mjs";

test("queue queries retain retry time, attempt ceiling and bounded limits", () => {
  const queries = [];
  const reader = new CollaborationDeliveryReader({
    store: { selectAll: (sql, params) => { queries.push({ sql, params }); return []; } },
    clock: () => "now", listArtifacts: () => []
  });
  assert.deepEqual(reader.listPendingDeliveries(5000, 3), []);
  assert.deepEqual(queries[0].params, [3, "now", 1000]);
  assert.match(queries[0].sql, /next_attempt_at <= \?/);
  reader.listQueuedDeliveriesForAgent("agent", -1);
  assert.deepEqual(queries[1].params, ["agent", 1]);
  reader.listQueuedDeliveries();
  assert.deepEqual(queries[2].params, [100]);
});

test("missing deliveries do not query artifacts", () => {
  const reader = new CollaborationDeliveryReader({
    store: { selectOne: () => null },
    listArtifacts: () => { throw new Error("unexpected artifact lookup"); }
  });
  assert.equal(reader.getDeliveryEnvelope("missing"), null);
});

test("legacy envelope separates message recipient from task recipient and picks latest artifact", () => {
  const artifact = { artifactId: "latest" };
  const reader = new CollaborationDeliveryReader({
    store: { selectOne: () => ({
      delivery_id: "delivery", message_id: "message", task_id: "task",
      recipient_agent_id: "message-recipient", task_recipient_agent_id: "task-recipient",
      attempt_count: "2", routing_version: "3", evidence_json: "broken",
      task_status: "working", message_created_at: "sent", created_at: "queued"
    }) },
    listArtifacts: (taskId) => { assert.equal(taskId, "task"); return [{ artifactId: "old" }, artifact]; }
  });
  const value = reader.getDeliveryEnvelope("delivery");
  assert.equal(value.message.recipientAgentId, "message-recipient");
  assert.equal(value.task.recipientAgentId, "task-recipient");
  assert.equal(value.message.createdAt, "sent");
  assert.equal(value.delivery.createdAt, "queued");
  assert.equal(value.latestArtifact, artifact);
  assert.equal(value.message.envelope, null);
  assert.deepEqual(value.message.evidence, []);
});
