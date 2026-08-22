import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborationEnvelope,
  validateCollaborationEnvelope
} from "../src/collaboration/collaborationProtocol.mjs";

function envelope(overrides = {}) {
  return createCollaborationEnvelope({
    messageId: "message:1",
    taskId: "task:1",
    messageType: "change_request",
    senderAgentId: "agent:a",
    recipientAgentId: "agent:b",
    sourceObjectiveId: "objective:a",
    targetObjectiveId: "objective:b",
    sourceWorkItemId: "work_item:source",
    workItemId: "work_item:target",
    payload: { body: "Implement the requested change.", evidence: [], resourceVersion: "v1" },
    timestamp: "2026-08-20T00:00:00.000Z",
    error: null,
    ...overrides
  });
}

test("protocol v2 envelope contains every routable and auditable field", () => {
  const value = envelope();
  assert.equal(value.version, COLLABORATION_PROTOCOL_VERSION);
  assert.deepEqual(value.sender, { agentId: "agent:a", sessionId: null, objectiveId: "objective:a" });
  assert.deepEqual(value.recipient, { agentId: "agent:b", sessionId: null, objectiveId: "objective:b" });
  assert.deepEqual(value.workItem, { id: "work_item:target", sourceId: "work_item:source" });
  assert.equal(value.error, null);
});

test("protocol validation rejects unknown fields, invalid timestamps, and malformed errors", () => {
  assert.throws(
    () => validateCollaborationEnvelope({ ...envelope(), surprise: true }),
    (error) => error.code === "UNKNOWN_MESSAGE_FIELD" && error.field === "surprise"
  );
  assert.throws(
    () => validateCollaborationEnvelope({ ...envelope(), timestamp: "tomorrow" }),
    (error) => error.code === "INVALID_TIMESTAMP"
  );
  assert.throws(
    () => validateCollaborationEnvelope({ ...envelope(), error: { code: "FAILED", message: "No", retryable: "yes" } }),
    (error) => error.code === "INVALID_ERROR"
  );
});

test("protocol validation prevents Objective and party identity divergence", () => {
  const value = envelope();
  assert.throws(
    () => validateCollaborationEnvelope({
      ...value,
      objective: { ...value.objective, targetId: "objective:other" }
    }),
    (error) => error.code === "OBJECTIVE_PARTY_MISMATCH"
  );
});
