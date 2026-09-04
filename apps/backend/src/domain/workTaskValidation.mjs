const WORK_CREATE_FIELDS = [
  "id", "name", "description", "avatarPath", "status", "profile", "tags",
  "workspaceId", "contributorAgentIds", "primaryAgentId"
];

const WORK_UPDATE_FIELDS = WORK_CREATE_FIELDS.filter(
  (field) => field !== "id" && field !== "workspaceId"
);

const TASK_CREATE_FIELDS = [
  "id", "workId", "title", "description", "acceptanceCriteria",
  "verificationCriteria", "priority", "lifecycleState", "mainAgentId"
];

const TASK_UPDATE_FIELDS = TASK_CREATE_FIELDS.filter(
  (field) => field !== "id" && field !== "workId"
);

export const ENTITY_FIELD_ALLOWLISTS = Object.freeze({
  workCreate: Object.freeze(WORK_CREATE_FIELDS),
  workUpdate: Object.freeze(WORK_UPDATE_FIELDS),
  taskCreate: Object.freeze(TASK_CREATE_FIELDS),
  taskUpdate: Object.freeze(TASK_UPDATE_FIELDS)
});

export class EntityValidationError extends TypeError {
  constructor(code, field, expected, received, message = null) {
    super(message ?? `Invalid value for field "${field}".`);
    this.name = "EntityValidationError";
    this.code = code;
    this.field = field;
    this.expected = expected;
    this.received = summarizeReceived(received);
  }
}

export function validateWorkInput(input, operation = "create") {
  const allowed = operation === "update"
    ? ENTITY_FIELD_ALLOWLISTS.workUpdate
    : ENTITY_FIELD_ALLOWLISTS.workCreate;
  assertRecord(input, operation === "update" ? "patch" : "input");
  assertKnownFields(input, allowed, operation);

  const normalized = { ...input };
  if (has(input, "id")) normalized.id = string(input.id, "id", { nonEmpty: true });
  if (has(input, "name")) normalized.name = string(input.name, "name", { nonEmpty: true, trim: true });
  if (has(input, "description")) normalized.description = string(input.description, "description");
  if (has(input, "avatarPath")) normalized.avatarPath = optionalString(input.avatarPath, "avatarPath");
  if (has(input, "status")) normalized.status = string(input.status, "status", { nonEmpty: true, trim: true });
  if (has(input, "profile")) normalized.profile = string(input.profile, "profile", { nonEmpty: true, trim: true });
  if (has(input, "tags")) normalized.tags = stringArray(input.tags, "tags", { trim: true });
  if (has(input, "workspaceId")) normalized.workspaceId = optionalString(input.workspaceId, "workspaceId", { trim: true });
  if (has(input, "contributorAgentIds")) normalized.contributorAgentIds = stringArray(input.contributorAgentIds, "contributorAgentIds", { trim: true, nonEmpty: true });
  if (has(input, "primaryAgentId")) normalized.primaryAgentId = optionalString(input.primaryAgentId, "primaryAgentId", { trim: true });

  if (has(input, "status") && !["active", "archived"].includes(normalized.status)) {
    throw new EntityValidationError("INVALID_WORK_STATUS", "status", "active | archived", input.status);
  }
  if (has(input, "profile") && !["general", "software", "office", "data", "design"].includes(normalized.profile)) {
    throw new EntityValidationError(
      "INVALID_WORK_PROFILE", "profile", "general | software | office | data | design", input.profile
    );
  }

  if (operation === "create" && !has(input, "name")) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", "name", "non-empty string", undefined, "Work name is required.");
  }
  if (operation === "create" && (!has(input, "contributorAgentIds") || normalized.contributorAgentIds.length === 0)) {
    throw new EntityValidationError(
      "WORK_CONTRIBUTOR_REQUIRED",
      "contributorAgentIds",
      "at least one assignable Agent ID",
      input.contributorAgentIds,
      "A Work requires at least one contributor Agent."
    );
  }
  if (normalized.primaryAgentId && has(input, "contributorAgentIds")
    && !normalized.contributorAgentIds.includes(normalized.primaryAgentId)) {
    throw new EntityValidationError(
      "PRIMARY_AGENT_OUTSIDE_WORK",
      "primaryAgentId",
      "Agent ID included in contributorAgentIds",
      normalized.primaryAgentId
    );
  }
  return normalized;
}

export function validateTaskInput(input, operation = "create") {
  const allowed = operation === "update"
    ? ENTITY_FIELD_ALLOWLISTS.taskUpdate
    : ENTITY_FIELD_ALLOWLISTS.taskCreate;
  assertRecord(input, operation === "update" ? "patch" : "input");
  assertKnownFields(input, allowed, operation);

  const normalized = { ...input };
  if (has(input, "id")) normalized.id = string(input.id, "id", { nonEmpty: true });
  if (has(input, "workId")) normalized.workId = string(input.workId, "workId", { nonEmpty: true, trim: true });
  if (has(input, "title")) normalized.title = string(input.title, "title", { nonEmpty: true, trim: true });
  if (has(input, "description")) normalized.description = string(input.description, "description");
  if (has(input, "acceptanceCriteria")) normalized.acceptanceCriteria = string(input.acceptanceCriteria, "acceptanceCriteria");
  if (has(input, "verificationCriteria")) normalized.verificationCriteria = string(input.verificationCriteria, "verificationCriteria");
  if (has(input, "priority")) normalized.priority = string(input.priority, "priority", { nonEmpty: true, trim: true });
  if (has(input, "lifecycleState")) normalized.lifecycleState = string(input.lifecycleState, "lifecycleState", { nonEmpty: true, trim: true });
  if (has(input, "priority") && !TASK_PRIORITIES.includes(normalized.priority)) {
    throw new EntityValidationError("INVALID_PRIORITY", "priority", TASK_PRIORITIES.join(" | "), input.priority);
  }
  if (has(input, "lifecycleState") && !TASK_LIFECYCLE_STATES.includes(normalized.lifecycleState)) {
    throw new EntityValidationError("INVALID_LIFECYCLE_STATE", "lifecycleState", TASK_LIFECYCLE_STATES.join(" | "), input.lifecycleState);
  }
  if (has(input, "mainAgentId")) normalized.mainAgentId = optionalString(input.mainAgentId, "mainAgentId", { trim: true });

  if (operation === "create" && !has(input, "workId")) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", "workId", "non-empty string", undefined, "Task workId is required.");
  }
  if (operation === "create" && !has(input, "title")) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", "title", "non-empty string", undefined, "Task title is required.");
  }
  return normalized;
}

export function associationError(code, field, expected, received, message) {
  return new EntityValidationError(code, field, expected, received, message);
}

export function validateEntityName(value, field = "name", entity = "Entity") {
  string(value, field, { nonEmpty: true });
  if (!/^[A-Za-z0-9\p{Script=Han}]+$/u.test(value)) {
    throw new EntityValidationError(
      "INVALID_ENTITY_NAME",
      field,
      "uppercase or lowercase English letters, Chinese characters, or digits only",
      value,
      `${entity} ${field} may only contain English letters, Chinese characters, or digits.`
    );
  }
  return value;
}

function assertRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", field, "object", value);
  }
}

function assertKnownFields(input, allowed, operation) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).find((field) => !allowedSet.has(field));
  if (!unknown) return;
  throw new EntityValidationError(
    operation === "update" ? "UNKNOWN_PATCH_FIELD" : "UNKNOWN_FIELD",
    unknown,
    `one of: ${allowed.join(", ")}`,
    input[unknown],
    `Unknown field "${unknown}".`
  );
}

function string(value, field, options = {}) {
  if (typeof value !== "string") {
    throw new EntityValidationError("INVALID_FIELD_TYPE", field, options.nonEmpty ? "non-empty string" : "string", value);
  }
  const normalized = options.trim ? value.trim() : value;
  if (options.nonEmpty && !normalized) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", field, "non-empty string", value);
  }
  return normalized;
}

function optionalString(value, field, options = {}) {
  if (value == null || value === "") return null;
  return string(value, field, { ...options, nonEmpty: true });
}

function stringArray(value, field, options = {}) {
  if (!Array.isArray(value)) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", field, "array of strings", value);
  }
  const normalized = value.map((entry, index) => string(entry, `${field}[${index}]`, options));
  return [...new Set(normalized)];
}

function summarizeReceived(value) {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value.slice(0, 3).map((entry) => scalarPreview(entry))
    };
  }
  if (typeof value === "object") {
    return { type: "object", keys: Object.keys(value).slice(0, 8) };
  }
  return { type: typeof value, value: scalarPreview(value) };
}

function scalarPreview(value) {
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (["number", "boolean"].includes(typeof value) || value == null) return value;
  return `<${typeof value}>`;
}

function has(input, field) {
  return Object.prototype.hasOwnProperty.call(input, field);
}
import { TASK_PRIORITIES, TASK_LIFECYCLE_STATES } from "./taskToolSchema.mjs";
