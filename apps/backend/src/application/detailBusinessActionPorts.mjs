import { createHash } from "node:crypto";
import { deviceError, pairedDeviceActor } from "./clientDeviceAuthority.mjs";

const deny = (code, status = 409) => { throw deviceError(code, status); };
/** Real product ports over the existing authorized inspector services. No
 * provider adapters, URL dispatch, arbitrary store mutation or second journal. */
export function createDetailBusinessActionPorts({ inspector, schedules }) {
  const bound = scope => {
    const value = inspector.scope(scope.sessionId, scope.identity);
    if ((value.logicalSessionId ?? value.sessionId) !== scope.sessionId) deny("DETAIL_SCOPE_CHANGED", 403);
    if (scope.identity.kind === "local_user") {
      value.actor = { type: "user", id: "user:local-macos" };
      value.context = { ...value.context, actorId: scope.identity.principalId };
    }
    return value;
  };
  const memory = (scope, target) => inspector.memory(bound(scope), target.id);
  const reference = (scope, target) => inspector.references.ownedReference(bound(scope).sessionId, target.id);
  const referenceOwner = scope => ({ sessionId: bound(scope).sessionId,
    references: inspector.references.list(bound(scope).sessionId) });
  const revision = resource => createHash("sha256").update(JSON.stringify(resource)).digest("hex");
  const requireCurrent = (scope, target, previous, get) => {
    scope.revalidateSync?.();
    scope.readGuard?.();
    const current = get(scope, target);
    if (revision(current) !== revision(previous)) deny("DETAIL_REVISION_CONFLICT");
    return current;
  };
  const memoryPort = operation => ({
    capability: () => typeof inspector.perform === "function",
    resource: memory, revision,
    authorize: (scope, target) => Boolean(memory(scope, target)),
    validateFields: (_scope, _target, fields, row) => operation === "memory.update"
      ? !row.revoked_at && typeof fields.content === "string" && Boolean(fields.content.trim())
        && fields.content.length <= 16000 && (!fields.tags || fields.tags.every(tag => tag.trim().length > 0 && tag.length <= 256))
      : fields.confirmed === true,
    execute: (scope, target, fields, { resource, fingerprint }) => {
      const current = requireCurrent(scope, target, resource, memory);
      return inspector.perform(bound(scope), operation === "memory.delete" ? "memory.revoke" : operation,
        { ...fields, ...(operation === "memory.update" && !Object.hasOwn(fields, "tags") ? {
          tags: Array.isArray(current.tags) ? current.tags : JSON.parse(current.tags_json ?? "[]")
        } : {}), id: target.id, expectedVersion: Number(current.version ?? 1) }, fingerprint);
    }
  });
  return {
    "reference.add": {
      capability: (scope, target) => target.resourceType === "session" && target.id === scope.sessionId
        && typeof inspector.references?.create === "function",
      resource: referenceOwner, revision,
      authorize: (scope, target) => target.resourceType === "session" && target.id === scope.sessionId && Boolean(bound(scope)),
      validateFields: (_scope, _target, fields) => {
        try {
          const url = new URL(fields.locator);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
            && fields.locator.length <= 4096 && (!fields.displayName || fields.displayName.length <= 512);
        } catch { return false; }
      },
      execute: (scope, target, fields, { resource }) => {
        requireCurrent(scope, target, resource, referenceOwner);
        return inspector.references.create(bound(scope).sessionId,
          { targetType: "webURL", locator: fields.locator, ...(fields.displayName ? { displayName: fields.displayName } : {}) },
          { beforeWrite: () => requireCurrent(scope, target, resource, referenceOwner) });
      }
    },
    "memory.update": memoryPort("memory.update"),
    // Existing soft revoke/audit semantics, never physical deletion.
    "memory.delete": memoryPort("memory.delete"),
    "reference.remove": {
      capability: () => typeof inspector.references?.delete === "function",
      resource: reference, revision,
      authorize: (scope, target) => Boolean(reference(scope, target)),
      validateFields: (_scope, _target, fields) => fields.confirmed === true,
      execute: (scope, target, _fields, { resource }) => {
        requireCurrent(scope, target, resource, reference);
        inspector.references.delete(bound(scope).sessionId, target.id);
        return { removed: true };
      }
    },
    "schedule.cancel": {
      capability: () => typeof schedules?.cancel === "function" && typeof inspector.store?.getScheduledSessionTask === "function",
      resource: (_scope, target) => inspector.store.getScheduledSessionTask(target.id),
      revision: row => String(row.resourceVersion),
      authorize: (scope, _target, row) => Boolean(row && row.logicalSessionId === bound(scope).logicalSessionId),
      validateFields: (_scope, _target, fields, row) => fields.confirmed === true && Number.isSafeInteger(row.resourceVersion),
      execute: (scope, target, _fields, { resource }) => {
        scope.revalidateSync?.();
        scope.readGuard?.();
        const value = bound(scope);
        return schedules.cancel(target.id, scope.identity.kind === "local_user" ? value.actor : pairedDeviceActor(scope.identity),
          { expectedResourceVersion: resource.resourceVersion });
      }
    }
  };
}
