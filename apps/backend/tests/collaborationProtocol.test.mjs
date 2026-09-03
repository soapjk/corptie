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
    senderSessionId: "session:a",
    recipientSessionId: "session:b",
    sourceWorkId: "work:a",
    targetWorkId: "work:b",
    sourceTaskId: "task:source",
    targetTaskId: "task:target",
    payload: { body: "Implement the requested change.", evidence: [], resourceVersion: "v1" },
    timestamp: "2026-08-20T00:00:00.000Z",
    error: null,
    ...overrides
  });
}

test("protocol v3 makes Sessions the actors and keeps other entities as resource context", () => {
  const value = envelope();
  assert.equal(value.version, COLLABORATION_PROTOCOL_VERSION);
  assert.deepEqual(value.sender, { sessionId: "session:a" });
  assert.deepEqual(value.recipient, { sessionId: "session:b" });
  assert.deepEqual(value.resources, {
    sourceAgentId: "agent:a",
    targetAgentId: "agent:b",
    sourceWorkId: "work:a",
    targetWorkId: "work:b",
    sourceTaskId: "task:source",
    targetTaskId: "task:target"
  });
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

test("protocol validation requires distinct Session actors", () => {
  const value = envelope();
  assert.throws(
    () => validateCollaborationEnvelope({
      ...value,
      recipient: { sessionId: value.sender.sessionId }
    }),
    (error) => error.code === "INVALID_PARTICIPANTS"
  );
});
