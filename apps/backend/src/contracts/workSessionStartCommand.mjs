export const WORK_SESSION_START_FIELDS = Object.freeze([
  "taskId", "assigneeAgentId", "expectedTaskVersion", "providerId", "title",
  "idempotencyKey", "sourceSessionId"
]);

const FIELDS = new Set(WORK_SESSION_START_FIELDS);

/** Strict business-layer decoder for the one authoritative startup command. */
export function decodeWorkSessionStartCommand(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw startContractError("UNKNOWN_START_FIELD", "Work Session start input must be an object.");
  }
  const unknown = Object.keys(input).filter((field) => !FIELDS.has(field));
  if (unknown.length > 0) {
    throw startContractError(
      "UNKNOWN_START_FIELD",
      `Unknown Work Session start field: ${unknown.sort().join(", ")}.`,
      { fields: unknown.sort() }
    );
  }
  const taskId = namespaced(input.taskId, "task:", "TASK_NOT_FOUND", "taskId");
  const assigneeAgentId = namespaced(
    input.assigneeAgentId,
    "agent:",
    input.assigneeAgentId == null || String(input.assigneeAgentId).trim() === ""
      ? "START_ASSIGNEE_REQUIRED"
      : "INVALID_AGENT_ID",
    "assigneeAgentId"
  );
  const expectedTaskVersion = Number(input.expectedTaskVersion);
  if (!Number.isInteger(expectedTaskVersion) || expectedTaskVersion < 1) {
    throw startContractError("TASK_VERSION_CONFLICT", "expectedTaskVersion must be a positive integer.");
  }
  const sourceSessionId = text(input.sourceSessionId);
  if (!sourceSessionId || (!sourceSessionId.startsWith("session:") && !sourceSessionId.startsWith("logical:"))) {
    throw startContractError("SOURCE_SESSION_NOT_FOUND", "sourceSessionId must identify an authenticated logical Session.");
  }
  return Object.freeze({
    taskId,
    assigneeAgentId,
    expectedTaskVersion,
    providerId: requiredText(input.providerId, "PROVIDER_CAPABILITY_UNAVAILABLE", "providerId"),
    ...(text(input.title) ? { title: text(input.title) } : {}),
    idempotencyKey: boundedText(input.idempotencyKey, "idempotencyKey", 200),
    sourceSessionId
  });
}

export function startContractError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.stage = "validation";
  error.statusCode = code.endsWith("_NOT_FOUND") ? 404 : code === "TASK_VERSION_CONFLICT" ? 409 : 400;
  error.retryable = false;
  if (details) error.details = details;
  return error;
}

function namespaced(value, prefix, code, field) {
  const normalized = text(value);
  if (!normalized || !normalized.startsWith(prefix)) {
    throw startContractError(code, `${field} must use the ${prefix} namespace.`);
  }
  return normalized;
}

function requiredText(value, code, field) {
  const normalized = text(value);
  if (!normalized) throw startContractError(code, `${field} is required.`);
  return normalized;
}

function boundedText(value, field, maximum) {
  const normalized = requiredText(value, "START_IDEMPOTENCY_REQUIRED", field);
  if (normalized.length > maximum) {
    throw startContractError("START_IDEMPOTENCY_INVALID", `${field} must not exceed ${maximum} characters.`);
  }
  return normalized;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
