import { createHash, randomUUID } from "node:crypto";

const COMMANDS = new Set(["createRecord", "updateRecord", "completeItem", "archiveRecord", "batchApply"]);

export class SceneApplicationService {
  constructor({ store, now = () => new Date().toISOString(), createId = () => randomUUID() }) {
    if (!store) throw new TypeError("SceneApplicationService requires a store.");
    this.store = store;
    this.now = now;
    this.createId = createId;
  }

  listTemplates() {
    return this.store.selectAll(
      `SELECT template_id, version, title, description
       FROM scene_template_versions ORDER BY title, version DESC`
    ).map((row) => ({
      templateId: row.template_id,
      version: Number(row.version),
      title: row.title,
      description: row.description
    }));
  }

  getTemplate(templateId, version = 1) {
    const row = this.store.selectOne(
      `SELECT definition_json FROM scene_template_versions WHERE template_id=? AND version=?`,
      [requiredString(templateId, "templateId"), requiredInteger(version, "version")]
    );
    return row ? JSON.parse(row.definition_json) : null;
  }

  createScene(input) {
    const templateId = requiredString(input?.templateId, "templateId");
    const templateVersion = requiredInteger(input?.templateVersion ?? 1, "templateVersion");
    const name = boundedString(input?.name, "name", 1, 120);
    const timezone = boundedString(input?.timezone, "timezone", 1, 100);
    const ownerScope = boundedString(input?.ownerScope ?? "local-user", "ownerScope", 1, 200);
    const template = this.getTemplate(templateId, templateVersion);
    if (!template) throw sceneError("SCENE_TEMPLATE_NOT_FOUND", 404, "Scene template version was not found.");
    assertTimeZone(timezone);
    const unitPreferences = plainObject(input?.unitPreferences ?? {}, "unitPreferences");
    const instanceId = input?.instanceId
      ? requiredString(input.instanceId, "instanceId")
      : `scene:${this.createId()}`;
    const createdAt = this.now();

    this.store.runInTransaction(() => {
      this.store.db.run(
        `INSERT INTO scene_instances (
           instance_id, owner_scope, template_id, template_version, name, timezone,
           unit_preferences_json, status, instance_revision, resource_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, 1, ?, ?)`,
        [instanceId, ownerScope, templateId, templateVersion, name, timezone,
          JSON.stringify(unitPreferences), createdAt, createdAt]
      );
      template.defaultViews.forEach((view, index) => {
        this.store.db.run(
          `INSERT INTO scene_views (instance_id, view_id, title, kind, definition_json, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [instanceId, view.viewId, view.title, view.kind, JSON.stringify(view), index]
        );
      });
      this.store.scheduleSave();
    });
    return this.getScene(instanceId);
  }

  getScene(instanceId) {
    const row = this.store.selectOne(
      `SELECT * FROM scene_instances WHERE instance_id=?`,
      [requiredString(instanceId, "instanceId")]
    );
    return row ? presentScene(row) : null;
  }

  listScenes({ includeArchived = false } = {}) {
    const rows = this.store.selectAll(
      `SELECT * FROM scene_instances ${includeArchived ? "" : "WHERE status <> 'archived'"}
       ORDER BY updated_at DESC, instance_id`
    );
    return rows.map(presentScene);
  }

  readView(instanceId, viewId, { limit = 100, offset = 0 } = {}) {
    const scene = this.requireScene(instanceId);
    const viewRow = this.store.selectOne(
      `SELECT * FROM scene_views WHERE instance_id=? AND view_id=?`,
      [scene.instanceId, requiredString(viewId, "viewId")]
    );
    if (!viewRow) throw sceneError("SCENE_VIEW_NOT_FOUND", 404, "Scene view was not found.");
    const view = JSON.parse(viewRow.definition_json);
    const types = Array.isArray(view.recordTypes) ? view.recordTypes : [];
    const boundedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    if (types.length === 0) return { scene, view, records: [], nextOffset: null };
    const placeholders = types.map(() => "?").join(",");
    const rows = this.store.selectAll(
      `SELECT * FROM scene_records
       WHERE instance_id=? AND deleted_at IS NULL AND record_type IN (${placeholders})
       ORDER BY updated_at DESC, record_id LIMIT ? OFFSET ?`,
      [scene.instanceId, ...types, boundedLimit + 1, boundedOffset]
    );
    return {
      scene,
      view,
      records: rows.slice(0, boundedLimit).map(presentRecord),
      nextOffset: rows.length > boundedLimit ? boundedOffset + boundedLimit : null
    };
  }

  getRecord(instanceId, recordId, { includeArchived = false } = {}) {
    const row = this.store.selectOne(
      `SELECT * FROM scene_records WHERE instance_id=? AND record_id=?
       ${includeArchived ? "" : "AND deleted_at IS NULL"}`,
      [requiredString(instanceId, "instanceId"), requiredString(recordId, "recordId")]
    );
    return row ? presentRecord(row) : null;
  }

  executeCommand(input) {
    const instanceId = requiredString(input?.instanceId, "instanceId");
    const command = requiredString(input?.command, "command");
    if (!COMMANDS.has(command)) {
      throw sceneError("SCENE_COMMAND_UNSUPPORTED", 400, `Unsupported scene command: ${command}`);
    }
    const idempotencyKey = boundedString(input?.idempotencyKey, "idempotencyKey", 1, 200);
    const canonicalRequest = stableStringify({
      command,
      payload: input?.payload ?? {},
      expectedInstanceRevision: input?.expectedInstanceRevision ?? null,
      sourceSessionId: input?.sourceSessionId ?? null,
      sourceKind: input?.sourceKind ?? "manual"
    });
    const requestHash = createHash("sha256").update(canonicalRequest).digest("hex");
    const existingReceipt = this.store.selectOne(
      `SELECT request_hash, result_json FROM scene_command_receipts
       WHERE instance_id=? AND idempotency_key=?`,
      [instanceId, idempotencyKey]
    );
    if (existingReceipt) return receiptResult(existingReceipt, requestHash);

    return this.store.runInTransaction(() => {
      const concurrentReceipt = this.store.selectOne(
        `SELECT request_hash, result_json FROM scene_command_receipts
         WHERE instance_id=? AND idempotency_key=?`,
        [instanceId, idempotencyKey]
      );
      if (concurrentReceipt) return receiptResult(concurrentReceipt, requestHash);

      const scene = this.requireScene(instanceId);
      if (input.expectedInstanceRevision != null
        && Number(input.expectedInstanceRevision) !== scene.instanceRevision) {
        throw conflict("SCENE_REVISION_CONFLICT", "Scene changed after the command was prepared.", { scene });
      }
      const template = this.getTemplate(scene.templateId, scene.templateVersion);
      if (!template.allowedActions.includes(command)) {
        throw sceneError("SCENE_COMMAND_FORBIDDEN", 422, "Template does not allow this command.");
      }
      const sourceKind = input?.sourceKind === "session" ? "session" : "manual";
      const sourceSessionId = sourceKind === "session"
        ? requiredString(input?.sourceSessionId, "sourceSessionId")
        : null;
      const changes = command === "batchApply"
        ? this.applyBatch(scene, template, input?.payload)
        : [this.applySingle(scene, template, command, input?.payload)];
      const revision = scene.instanceRevision + 1;
      const updatedAt = this.now();
      this.store.db.run(
        `UPDATE scene_instances
         SET instance_revision=?, resource_version=resource_version+1, updated_at=?
         WHERE instance_id=? AND instance_revision=?`,
        [revision, updatedAt, instanceId, scene.instanceRevision]
      );
      if (this.store.db.getRowsModified() !== 1) {
        throw conflict("SCENE_REVISION_CONFLICT", "Scene changed while committing the command.");
      }
      const mutationId = `scene-mutation:${this.createId()}`;
      const summary = summarize(command, changes);
      this.store.db.run(
        `INSERT INTO scene_mutations (
           mutation_id, instance_id, instance_revision, source_session_id, source_kind,
           command_name, summary, changes_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [mutationId, instanceId, revision, sourceSessionId, sourceKind,
          command, summary, JSON.stringify(changes), updatedAt]
      );
      const result = { mutationId, instanceId, instanceRevision: revision, summary, changes };
      this.store.db.run(
        `INSERT INTO scene_command_receipts (
           instance_id, idempotency_key, request_hash, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [instanceId, idempotencyKey, requestHash, JSON.stringify(result), updatedAt]
      );
      this.store.scheduleSave();
      return result;
    });
  }

  changesAfter(instanceId, revision = 0, limit = 200) {
    this.requireScene(instanceId);
    return this.store.selectAll(
      `SELECT * FROM scene_mutations
       WHERE instance_id=? AND instance_revision>?
       ORDER BY instance_revision LIMIT ?`,
      [instanceId, Math.max(0, Number(revision) || 0), Math.min(500, Math.max(1, Number(limit) || 200))]
    ).map((row) => ({
      mutationId: row.mutation_id,
      instanceId: row.instance_id,
      instanceRevision: Number(row.instance_revision),
      sourceSessionId: row.source_session_id,
      sourceKind: row.source_kind,
      command: row.command_name,
      summary: row.summary,
      changes: JSON.parse(row.changes_json),
      createdAt: row.created_at
    }));
  }

  applyBatch(scene, template, payload) {
    const commands = payload?.commands;
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 100) {
      throw sceneError("SCENE_BATCH_INVALID", 400, "batchApply requires 1 to 100 commands.");
    }
    return commands.map((entry) => {
      const command = requiredString(entry?.command, "payload.commands[].command");
      if (command === "batchApply" || !COMMANDS.has(command) || !template.allowedActions.includes(command)) {
        throw sceneError("SCENE_COMMAND_UNSUPPORTED", 400, `Unsupported batch command: ${command}`);
      }
      return this.applySingle(scene, template, command, entry?.payload);
    });
  }

  applySingle(scene, template, command, payload) {
    if (command === "createRecord") return this.createRecord(scene, template, payload);
    const recordId = requiredString(payload?.recordId, "payload.recordId");
    const currentRow = this.store.selectOne(
      `SELECT * FROM scene_records WHERE instance_id=? AND record_id=? AND deleted_at IS NULL`,
      [scene.instanceId, recordId]
    );
    if (!currentRow) throw sceneError("SCENE_RECORD_NOT_FOUND", 404, "Scene record was not found.");
    const current = presentRecord(currentRow);
    if (payload?.expectedRecordVersion == null
      || Number(payload.expectedRecordVersion) !== current.recordVersion) {
      throw conflict("SCENE_RECORD_VERSION_CONFLICT", "Scene record changed after it was read.", { record: current });
    }
    if (command === "archiveRecord") {
      const archivedAt = this.now();
      this.store.db.run(
        `UPDATE scene_records SET deleted_at=?, record_version=record_version+1, updated_at=?
         WHERE instance_id=? AND record_id=? AND record_version=? AND deleted_at IS NULL`,
        [archivedAt, archivedAt, scene.instanceId, recordId, current.recordVersion]
      );
      assertOneRecordUpdated(this.store, current);
      return { operation: command, before: current, after: null };
    }
    const patch = command === "completeItem" ? { completed: true } : plainObject(payload?.patch, "payload.patch");
    if (Object.keys(patch).length === 0) {
      throw sceneError("SCENE_PATCH_EMPTY", 400, "Record update patch cannot be empty.");
    }
    const data = { ...current.data, ...patch };
    this.validateRecord(scene, template, current.recordType, data, recordId);
    const updatedAt = this.now();
    this.store.db.run(
      `UPDATE scene_records SET data_json=?, record_version=record_version+1, updated_at=?
       WHERE instance_id=? AND record_id=? AND record_version=? AND deleted_at IS NULL`,
      [JSON.stringify(data), updatedAt, scene.instanceId, recordId, current.recordVersion]
    );
    assertOneRecordUpdated(this.store, current);
    return {
      operation: command,
      before: current,
      after: { ...current, data, recordVersion: current.recordVersion + 1, updatedAt }
    };
  }

  createRecord(scene, template, payload) {
    const recordType = requiredString(payload?.recordType, "payload.recordType");
    const recordId = payload?.recordId
      ? requiredString(payload.recordId, "payload.recordId")
      : `scene-record:${this.createId()}`;
    const data = plainObject(payload?.data, "payload.data");
    this.validateRecord(scene, template, recordType, data, recordId);
    const createdAt = this.now();
    try {
      this.store.db.run(
        `INSERT INTO scene_records (
           instance_id, record_id, record_type, data_json, record_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [scene.instanceId, recordId, recordType, JSON.stringify(data), createdAt, createdAt]
      );
    } catch (error) {
      if (String(error?.message).includes("UNIQUE constraint failed")) {
        throw conflict("SCENE_RECORD_EXISTS", "Scene record already exists.");
      }
      throw error;
    }
    return {
      operation: "createRecord",
      before: null,
      after: { instanceId: scene.instanceId, recordId, recordType, data,
        recordVersion: 1, archivedAt: null, createdAt, updatedAt: createdAt }
    };
  }

  validateRecord(scene, template, recordType, data, currentRecordId) {
    const schema = template.recordTypes[recordType];
    if (!schema) throw sceneError("SCENE_RECORD_TYPE_INVALID", 422, "Record type is not allowed by the template.");
    validateObject(data, schema, "data");
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      const referenceSchema = referenceBranch(fieldSchema);
      if (!referenceSchema || data[field] == null) continue;
      if (data[field] === currentRecordId) {
        throw sceneError("SCENE_REFERENCE_INVALID", 422, `Field ${field} cannot reference its own record.`);
      }
      const target = this.store.selectOne(
        `SELECT record_type FROM scene_records
         WHERE instance_id=? AND record_id=? AND deleted_at IS NULL`,
        [scene.instanceId, data[field]]
      );
      if (!target || target.record_type !== referenceSchema.recordType) {
        throw sceneError(
          "SCENE_REFERENCE_INVALID", 422,
          `Field ${field} must reference an active ${referenceSchema.recordType} record in the same scene.`
        );
      }
    }
  }

  requireScene(instanceId) {
    const scene = this.getScene(instanceId);
    if (!scene) throw sceneError("SCENE_NOT_FOUND", 404, "Scene instance was not found.");
    if (scene.status !== "active") throw sceneError("SCENE_ARCHIVED", 409, "Scene instance is archived.");
    return scene;
  }
}

function validateObject(value, schema, path) {
  plainObject(value, path);
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw sceneError("SCENE_FIELD_UNKNOWN", 422, `Unknown field: ${path}.${key}`);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key) || value[key] == null) {
      throw sceneError("SCENE_FIELD_REQUIRED", 422, `Missing required field: ${path}.${key}`);
    }
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    validateValue(fieldValue, schema.properties[key], `${path}.${key}`);
  }
}

function validateValue(value, schema, path) {
  if (schema.anyOf) {
    const valid = schema.anyOf.some((branch) => {
      try { validateValue(value, branch, path); return true; } catch { return false; }
    });
    if (!valid) throw sceneError("SCENE_FIELD_INVALID", 422, `Invalid value for ${path}.`);
    return;
  }
  const typeMatches = schema.type === "null" ? value === null
    : schema.type === "integer" ? Number.isInteger(value)
    : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === schema.type;
  if (!typeMatches) throw sceneError("SCENE_FIELD_INVALID", 422, `Invalid type for ${path}.`);
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) throw invalidRange(path);
    if (schema.maxLength != null && value.length > schema.maxLength) throw invalidRange(path);
    if (schema.enum && !schema.enum.includes(value)) throw sceneError("SCENE_FIELD_INVALID", 422, `Invalid value for ${path}.`);
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidFormat(path);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) throw invalidFormat(path);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) throw invalidRange(path);
    if (schema.maximum != null && value > schema.maximum) throw invalidRange(path);
  }
}

function referenceBranch(schema) {
  if (schema?.format === "scene-reference") return schema;
  return schema?.anyOf?.find((branch) => branch.format === "scene-reference") ?? null;
}

function presentScene(row) {
  return {
    instanceId: row.instance_id,
    ownerScope: row.owner_scope,
    templateId: row.template_id,
    templateVersion: Number(row.template_version),
    name: row.name,
    timezone: row.timezone,
    unitPreferences: JSON.parse(row.unit_preferences_json),
    status: row.status,
    instanceRevision: Number(row.instance_revision),
    resourceVersion: Number(row.resource_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function presentRecord(row) {
  return {
    instanceId: row.instance_id,
    recordId: row.record_id,
    recordType: row.record_type,
    data: JSON.parse(row.data_json),
    recordVersion: Number(row.record_version),
    archivedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function summarize(command, changes) {
  return `${command}: ${changes.length} record${changes.length === 1 ? "" : "s"} changed`;
}

function receiptResult(row, requestHash) {
  if (row.request_hash !== requestHash) {
    throw conflict("SCENE_IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different command.");
  }
  return JSON.parse(row.result_json);
}

function assertOneRecordUpdated(store, record) {
  if (store.db.getRowsModified() !== 1) {
    throw conflict("SCENE_RECORD_VERSION_CONFLICT", "Scene record changed while committing.", { record });
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredString(value, field) {
  return boundedString(value, field, 1, 500);
}

function boundedString(value, field, minimum, maximum) {
  if (typeof value !== "string" || value.trim().length < minimum || value.trim().length > maximum) {
    throw sceneError("SCENE_INPUT_INVALID", 400, `${field} must contain ${minimum}-${maximum} characters.`);
  }
  return value.trim();
}

function requiredInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw sceneError("SCENE_INPUT_INVALID", 400, `${field} must be a positive integer.`);
  return number;
}

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw sceneError("SCENE_INPUT_INVALID", 400, `${field} must be an object.`);
  }
  return value;
}

function assertTimeZone(value) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); }
  catch { throw sceneError("SCENE_TIMEZONE_INVALID", 400, "timezone must be a valid IANA time zone."); }
}

function invalidRange(path) {
  return sceneError("SCENE_FIELD_INVALID", 422, `Value is outside the allowed range for ${path}.`);
}

function invalidFormat(path) {
  return sceneError("SCENE_FIELD_INVALID", 422, `Invalid format for ${path}.`);
}

function conflict(code, message, details) {
  return sceneError(code, 409, message, details);
}

function sceneError(code, statusCode, message, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}
