import test from "node:test";
import assert from "node:assert/strict";
import { CollaborationRecordWriter } from "../src/collaboration/collaborationRecordWriter.mjs";

test("event writes preserve sequence and canonical Session identity without committing", () => {
  const writes = [];
  const writer = new CollaborationRecordWriter({
    store: {
      selectOne: () => ({ sequence: "4" }),
      db: { run: (sql, params) => writes.push({ sql, params }) }
    },
    clock: () => "now", idFactory: () => "event",
    stableSessionIdentity: (id) => id === "provider" ? "logical" : id
  });
  writer.appendEvent("task", "changed", "agent", { value: 1 }, undefined, "provider");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params, ["event", "task", 5, "changed", "agent", "logical", '{"value":1}', "now"]);
});

test("message idempotency rejects reuse for another Task before writes", () => {
  const writer = new CollaborationRecordWriter({
    store: { selectOne: () => ({ task_id: "other" }) },
    stableSessionIdentity: (id) => id
  });
  assert.throws(() => writer.insertMessage({
    senderSessionId: "session", idempotencyKey: "key", taskId: "task"
  }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("artifact writes require service ownership before touching storage", () => {
  const writer = new CollaborationRecordWriter({
    store: {}, requireService: () => ({ serviceId: "service", ownerAgentId: "owner" })
  });
  assert.throws(() => writer.insertArtifact({ taskId: "task", serviceId: "service" }, "other", "session", {}, "now"), {
    code: "SERVICE_OWNER_REQUIRED"
  });
});
