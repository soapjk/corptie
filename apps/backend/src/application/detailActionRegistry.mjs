import { deviceError } from "./clientDeviceAuthority.mjs";

const string = (maxLength, minLength = 0) => ({ type: "string", minLength, maxLength });
const object = properties => ({ type: "object", properties, additionalProperties: false });
const confirmed = { const: true };
/** Stable product operations. Services are injected Provider-neutral ports.
 * Missing authorization/revision/execute ports make a command unavailable.
 */
export const DETAIL_ACTION_OPERATIONS = Object.freeze({
  "detail.refresh": { kind: "read", targetTypes: ["session"], fields: object({}) },
  "detail.collection.page": { kind: "read", targetTypes: ["session"], fields: { ...object({ collectionName: string(64, 1), cursor: string(512, 1) }), required: ["collectionName"] } },
  "resource.open": { kind: "navigation", targetTypes: ["session", "task", "work", "schedule", "artifact", "memory", "reference"], fields: object({}) },
  "editor.open": { kind: "navigation", targetTypes: ["task", "schedule", "provider", "worktree", "artifact", "memory", "reference"], fields: object({}) },
  "schedule.cancel": { kind: "command", targetTypes: ["schedule"], confirmation: "destructive", fields: { ...object({ confirmed }), required: ["confirmed"] } },
  "memory.update": { kind: "command", targetTypes: ["memory"], confirmation: "none", fields: { ...object({ content: string(16000, 1), tags: { type: "array", maxItems: 32, uniqueItems: true, items: string(256, 1) } }), required: ["content"] } },
  "memory.delete": { kind: "command", targetTypes: ["memory"], confirmation: "destructive", fields: { ...object({ confirmed, reason: string(4096) }), required: ["confirmed"] } },
  "reference.add": { kind: "command", targetTypes: ["session", "task", "artifact"], confirmation: "none", fields: { ...object({ locator: string(4096, 1), displayName: string(512) }), required: ["locator"] } },
  "reference.remove": { kind: "command", targetTypes: ["reference"], confirmation: "destructive", fields: { ...object({ confirmed }), required: ["confirmed"] } }
});

export class DetailActionRegistry {
  constructor({ ports = {}, validateFields }) { this.ports = ports; this.validateFields = validateFields; }
  operation(token, kind) {
    const definition = DETAIL_ACTION_OPERATIONS[token];
    if (!definition || definition.kind !== kind) throw deviceError("DETAIL_OPERATION_UNSUPPORTED", 409);
    return definition;
  }
  async prepare({ action, fields, expectedResourceRevision, scope }) {
    const definition = this.operation(action.operation, action.kind);
    if (!this.validateFields(action.operation, fields)) throw deviceError("DETAIL_FIELDS_INVALID", 400);
    if (definition.confirmation === "destructive" && fields.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
    if (!action.available) throw deviceError("DETAIL_ACTION_UNAVAILABLE", 409);
    const target = action.target ?? (action.operation === "detail.refresh" ? { resourceType: "session", id: scope.sessionId } : null);
    if (!target || !definition.targetTypes.includes(target.resourceType)) throw deviceError("DETAIL_TARGET_INVALID", 409);
    const port = this.ports[action.operation];
    if (action.kind === "command") {
      if (!port?.resource || !port?.authorize || !port?.execute || !port?.capability || !port?.validateFields) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
      if (await port.capability(scope, target) !== true) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
      const resource = await port.resource(scope, target);
      if (!resource || await port.authorize(scope, target, resource) !== true) throw deviceError("DETAIL_RESOURCE_FORBIDDEN", 403);
      // Existing business limits and safe reference locator parsing remain the
      // service's authority. This preflight must perform no network/file reads
      // selected by locator and no mutations.
      if (await port.validateFields(scope, target, fields, resource) !== true) throw deviceError("DETAIL_FIELDS_INVALID", 400);
      const revision = port.revision?.(resource);
      if (typeof revision !== "string" || !revision || !action.expectedResourceRevision) throw deviceError("DETAIL_REVISION_UNSUPPORTED", 409);
      if (expectedResourceRevision !== revision || action.expectedResourceRevision !== revision) throw deviceError("DETAIL_REVISION_CONFLICT", 409);
      // A port requiring a server confirmation token must validate it through
      // its own authorize/preflight implementation; the UI bool never grants it.
      return { definition, target, port, resource };
    }
    if (action.kind === "read" && action.operation !== "detail.refresh") {
      if (!port?.read || !port?.authorize || !port?.validateQuery) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
      if (await port.authorize(scope, target) !== true) throw deviceError("DETAIL_RESOURCE_FORBIDDEN", 403);
      // The collection service owns its registered collection names and
      // scope/revision-bound cursors. A generic action cannot select a resource.
      if (await port.validateQuery(scope, target, fields) !== true) throw deviceError("DETAIL_CURSOR_INVALID", 409);
    }
    return { definition, target, port };
  }
}
