const OBJECTIVE_CREATE_FIELDS = [
  "id", "name", "description", "acceptanceCriteria", "status", "budgetConfig",
  "priority", "targetDate", "tags", "workspaceIds", "relatedObjectiveIds",
  "contributorAgentIds"
];

const OBJECTIVE_UPDATE_FIELDS = OBJECTIVE_CREATE_FIELDS.filter((field) => field !== "id");

const WORK_ITEM_CREATE_FIELDS = [
  "id", "objectiveId", "title", "description", "acceptanceCriteria", "priority",
  "status", "mainWorkspaceId", "mainAgentId"
];

const WORK_ITEM_UPDATE_FIELDS = WORK_ITEM_CREATE_FIELDS.filter(
  (field) => field !== "id" && field !== "objectiveId"
);

export const ENTITY_FIELD_ALLOWLISTS = Object.freeze({
  objectiveCreate: Object.freeze(OBJECTIVE_CREATE_FIELDS),
  objectiveUpdate: Object.freeze(OBJECTIVE_UPDATE_FIELDS),
  workItemCreate: Object.freeze(WORK_ITEM_CREATE_FIELDS),
  workItemUpdate: Object.freeze(WORK_ITEM_UPDATE_FIELDS)
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

export function validateObjectiveInput(input, operation = "create") {
  const allowed = operation === "update"
    ? ENTITY_FIELD_ALLOWLISTS.objectiveUpdate
    : ENTITY_FIELD_ALLOWLISTS.objectiveCreate;
  assertRecord(input, operation === "update" ? "patch" : "input");
  assertKnownFields(input, allowed);

  const normalized = { ...input };
  if (has(input, "id")) normalized.id = string(input.id, "id", { nonEmpty: true });
  if (has(input, "name")) normalized.name = string(input.name, "name", { nonEmpty: true, trim: true });
  if (has(input, "description")) normalized.description = string(input.description, "description");
  if (has(input, "acceptanceCriteria")) normalized.acceptanceCriteria = string(input.acceptanceCriteria, "acceptanceCriteria");
  if (has(input, "status")) normalized.status = string(input.status, "status", { nonEmpty: true, trim: true });
  if (has(input, "budgetConfig")) normalized.budgetConfig = jsonObject(input.budgetConfig, "budgetConfig");
  if (has(input, "priority")) normalized.priority = optionalString(input.priority, "priority");
  if (has(input, "targetDate")) normalized.targetDate = optionalString(input.targetDate, "targetDate");
  if (has(input, "tags")) normalized.tags = stringArray(input.tags, "tags", { trim: true });
  if (has(input, "workspaceIds")) normalized.workspaceIds = stringArray(input.workspaceIds, "workspaceIds", { trim: true, nonEmpty: true });
  if (has(input, "relatedObjectiveIds")) normalized.relatedObjectiveIds = stringArray(input.relatedObjectiveIds, "relatedObjectiveIds", { trim: true, nonEmpty: true });
  if (has(input, "contributorAgentIds")) normalized.contributorAgentIds = stringArray(input.contributorAgentIds, "contributorAgentIds", { trim: true, nonEmpty: true });

  if (operation === "create" && !has(input, "name")) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", "name", "non-empty string", undefined, "Objective name is required.");
  }
  return normalized;
}

export function validateWorkItemInput(input, operation = "create") {
  const allowed = operation === "update"
    ? ENTITY_FIELD_ALLOWLISTS.workItemUpdate
    : ENTITY_FIELD_ALLOWLISTS.workItemCreate;
  assertRecord(input, operation === "update" ? "patch" : "input");
  assertKnownFields(input, allowed);

  const normalized = { ...input };
  if (has(input, "id")) normalized.id = string(input.id, "id", { nonEmpty: true });
  if (has(input, "objectiveId")) normalized.objectiveId = string(input.objectiveId, "objectiveId", { nonEmpty: true, trim: true });
  if (has(input, "title")) normalized.title = string(input.title, "title", { nonEmpty: true, trim: true });
  if (has(input, "description")) normalized.description = string(input.description, "description");
  if (has(input, "acceptanceCriteria")) normalized.acceptanceCriteria = string(input.acceptanceCriteria, "acceptanceCriteria");
  if (has(input, "priority")) normalized.priority = string(input.priority, "priority", { nonEmpty: true, trim: true });
  if (has(input, "status")) normalized.status = string(input.status, "status", { nonEmpty: true, trim: true });
  if (has(input, "mainWorkspaceId")) normalized.mainWorkspaceId = optionalString(input.mainWorkspaceId, "mainWorkspaceId", { trim: true });
  if (has(input, "mainAgentId")) normalized.mainAgentId = optionalString(input.mainAgentId, "mainAgentId", { trim: true });

  if (operation === "create" && !has(input, "objectiveId")) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", "objectiveId", "non-empty string", undefined, "WorkItem objectiveId is required.");
  }
  if (operation === "create" && !has(input, "title")) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", "title", "non-empty string", undefined, "WorkItem title is required.");
  }
  return normalized;
}

export function assertRepositoryId(value, field) {
  if (!value.startsWith("repository:")) {
    throw new EntityValidationError(
      "INVALID_ID_FORMAT",
      field,
      "registered repository: ID",
      value,
      `Field "${field}" only accepts repository: IDs.`
    );
  }
  return value;
}

export function associationError(code, field, expected, received, message) {
  return new EntityValidationError(code, field, expected, received, message);
}

function assertRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", field, "object", value);
  }
}

function assertKnownFields(input, allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).find((field) => !allowedSet.has(field));
  if (!unknown) return;
  throw new EntityValidationError(
    "UNKNOWN_FIELD",
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

function jsonObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EntityValidationError("INVALID_FIELD_TYPE", field, "JSON object", value);
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new EntityValidationError("INVALID_FIELD_TYPE", field, "JSON object", value);
  }
  return value;
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
