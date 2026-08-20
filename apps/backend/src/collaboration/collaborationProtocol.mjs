export const COLLABORATION_PROTOCOL_VERSION = "2.0";

export const COLLABORATION_MESSAGE_TYPES = Object.freeze([
  "question",
  "change_request",
  "needs_information",
  "update_ready",
  "verification_result"
]);

const MESSAGE_TYPE_SET = new Set(COLLABORATION_MESSAGE_TYPES);
const ENVELOPE_FIELDS = new Set([
  "version", "messageId", "messageType", "sender", "recipient", "objective",
  "workItem", "taskId", "payload", "timestamp", "error"
]);

export class CollaborationProtocolError extends TypeError {
  constructor(code, field, message) {
    super(message);
    this.name = "CollaborationProtocolError";
    this.code = code;
    this.field = field;
  }
}

export function createCollaborationEnvelope(input) {
  return validateCollaborationEnvelope({
    version: COLLABORATION_PROTOCOL_VERSION,
    messageId: input.messageId,
    messageType: input.messageType,
    sender: { agentId: input.senderAgentId, objectiveId: input.sourceObjectiveId },
    recipient: { agentId: input.recipientAgentId, objectiveId: input.targetObjectiveId },
    objective: { sourceId: input.sourceObjectiveId, targetId: input.targetObjectiveId },
    workItem: { id: input.workItemId, sourceId: input.sourceWorkItemId ?? null },
    taskId: input.taskId,
    payload: input.payload,
    timestamp: input.timestamp,
    error: input.error ?? null
  });
}

export function validateCollaborationEnvelope(input) {
  record(input, "envelope");
  const unknown = Object.keys(input).find((field) => !ENVELOPE_FIELDS.has(field));
  if (unknown) fail("UNKNOWN_MESSAGE_FIELD", unknown, `Unknown collaboration message field: ${unknown}.`);
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.hasOwn(input, field)) fail("MISSING_MESSAGE_FIELD", field, `Missing collaboration message field: ${field}.`);
  }
  if (input.version !== COLLABORATION_PROTOCOL_VERSION) {
    fail("UNSUPPORTED_PROTOCOL_VERSION", "version", `Unsupported collaboration protocol version: ${input.version}.`);
  }
  text(input.messageId, "messageId");
  text(input.taskId, "taskId");
  if (!MESSAGE_TYPE_SET.has(input.messageType)) {
    fail("INVALID_MESSAGE_TYPE", "messageType", `Unsupported collaboration message type: ${input.messageType}.`);
  }
  party(input.sender, "sender");
  party(input.recipient, "recipient");
  if (input.sender.agentId === input.recipient.agentId) {
    fail("INVALID_PARTICIPANTS", "recipient.agentId", "Sender and recipient Agents must be distinct.");
  }
  record(input.objective, "objective");
  exactFields(input.objective, "objective", ["sourceId", "targetId"]);
  text(input.objective.sourceId, "objective.sourceId");
  text(input.objective.targetId, "objective.targetId");
  if (input.objective.sourceId !== input.sender.objectiveId
    || input.objective.targetId !== input.recipient.objectiveId) {
    fail("OBJECTIVE_PARTY_MISMATCH", "objective", "Objective identifiers must match the sender and recipient scopes.");
  }
  record(input.workItem, "workItem");
  exactFields(input.workItem, "workItem", ["id", "sourceId"]);
  text(input.workItem.id, "workItem.id");
  nullableText(input.workItem.sourceId, "workItem.sourceId");
  record(input.payload, "payload");
  if (typeof input.payload.body !== "string" || !input.payload.body.trim()) {
    fail("INVALID_PAYLOAD", "payload.body", "Collaboration payload.body must be a non-empty string.");
  }
  if (!Array.isArray(input.payload.evidence ?? [])) {
    fail("INVALID_PAYLOAD", "payload.evidence", "Collaboration payload.evidence must be an array.");
  }
  const timestamp = Date.parse(input.timestamp);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== input.timestamp) {
    fail("INVALID_TIMESTAMP", "timestamp", "Collaboration timestamp must be an ISO-8601 UTC timestamp.");
  }
  if (input.error !== null) {
    record(input.error, "error");
    exactFields(input.error, "error", ["code", "message", "retryable"], true);
    text(input.error.code, "error.code");
    text(input.error.message, "error.message");
    if (Object.hasOwn(input.error, "retryable") && typeof input.error.retryable !== "boolean") {
      fail("INVALID_ERROR", "error.retryable", "error.retryable must be boolean when present.");
    }
  }
  return structuredClone(input);
}

function party(value, field) {
  record(value, field);
  exactFields(value, field, ["agentId", "objectiveId"]);
  text(value.agentId, `${field}.agentId`);
  text(value.objectiveId, `${field}.objectiveId`);
}

function exactFields(value, field, fields, allowMissing = false) {
  const expected = new Set(fields);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown) fail("UNKNOWN_MESSAGE_FIELD", `${field}.${unknown}`, `Unknown collaboration message field: ${field}.${unknown}.`);
  if (allowMissing) return;
  const missing = fields.find((key) => !Object.hasOwn(value, key));
  if (missing) fail("MISSING_MESSAGE_FIELD", `${field}.${missing}`, `Missing collaboration message field: ${field}.${missing}.`);
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_FIELD_TYPE", field, `${field} must be an object.`);
  }
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_FIELD_TYPE", field, `${field} must be a non-empty string.`);
  }
}

function nullableText(value, field) {
  if (value !== null) text(value, field);
}

function fail(code, field, message) {
  throw new CollaborationProtocolError(code, field, message);
}
