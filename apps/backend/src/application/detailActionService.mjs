import Ajv from "ajv";
import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";
import { clientCommandPrincipalKey } from "./clientCommandPrincipal.mjs";
import { executeClientCommand } from "./clientEntityCommands.mjs";
import { validateDetailContract } from "./detailDocumentContract.mjs";
import { canonicalDetailV2, validateDetailV2 } from "./detailSyncV2.mjs";
import { DetailActionRegistry, DETAIL_ACTION_OPERATIONS } from "./detailActionRegistry.mjs";

const hash = value => createHash("sha256").update(canonicalDetailV2(value)).digest("hex");
const authority = value => ["kind", "serverId", "accountId", "principalId", "deviceId"]
  .map(key => value?.[key] ?? null);
const ajv = new Ajv({ strict: false });
const validators = Object.fromEntries(Object.entries(DETAIL_ACTION_OPERATIONS).map(([token, operation]) => [token, ajv.compile(operation.fields)]));
export function createDetailActionRegistry(ports = {}) {
  return new DetailActionRegistry({ ports, validateFields: (token, fields) => validators[token]?.(fields) === true });
}

/** Auth and document ports must bind the current server-side Session scope.
 * This service never receives a Provider adapter or an arbitrary endpoint.
 */
export class DetailActionService {
  constructor({ commandAPI, registry, authorizeScope, documentFor }) {
    Object.assign(this, { commandAPI, registry, authorizeScope, documentFor });
  }
  async scope(identity, sessionId, authenticate, documentId = undefined) {
    const current = await authenticate();
    if (clientCommandPrincipalKey(current) !== clientCommandPrincipalKey(identity)
      || JSON.stringify(authority(current)) !== JSON.stringify(authority(identity))) throw deviceError("INVALID_CREDENTIAL", 401);
    // documentId is a lookup hint, never a permission/catalog grant. The host
    // resolves its authenticated projection/catalog variant server-side.
    const scope = await this.authorizeScope(current, sessionId, { documentId });
    if (!scope?.sessionId) throw deviceError("DETAIL_SCOPE_FORBIDDEN", 403);
    return { ...scope, identity: current, revalidateSync: () => {
      const value = authenticate();
      if (value?.then) { void Promise.resolve(value).catch(() => {}); throw deviceError("DETAIL_AUTH_GUARD_INVALID", 500); }
      if (clientCommandPrincipalKey(value) !== clientCommandPrincipalKey(current)
        || JSON.stringify(authority(value)) !== JSON.stringify(authority(current))) throw deviceError("INVALID_CREDENTIAL", 401);
      return value;
    } };
  }
  row(identity, requestId) {
    return this.commandAPI.store.selectOne("SELECT * FROM client_command_receipts WHERE device_id=? AND request_id=?", [clientCommandPrincipalKey(identity), requestId]);
  }
  async receipt(identity, sessionId, requestId, authenticate) {
    return (await this.prepareReceipt(identity, sessionId, requestId, authenticate)).value;
  }
  async prepareReceipt(identity, sessionId, requestId, authenticate) {
    const scope = await this.scope(identity, sessionId, authenticate);
    const row = this.row(scope.identity, requestId);
    if (!row || row.session_id !== scope.sessionId || !row.detail_request_hash) throw deviceError("COMMAND_NOT_FOUND", 404);
    return Object.freeze({ value: this.commandAPI.receipt(scope.identity, requestId), revalidate: scope.revalidateSync });
  }
  async resolve(scope, input, kind) {
    const document = await this.documentFor(scope);
    if (document.sessionId !== scope.sessionId || document.documentId !== input.documentId) throw deviceError("DETAIL_DOCUMENT_CHANGED", 409);
    let action;
    if (document.protocolVersion === 2) {
      // The host selects the scope/profile. Never infer capabilities from the
      // requested action or accept a client-supplied operation/target.
      validateDetailV2(document, { catalog: scope.catalog, clientCapabilities: scope.clientCapabilities });
      if (!Object.hasOwn(document.manifest.cards, input.cardId)) throw deviceError("DETAIL_ACTION_NOT_FOUND", 404);
      action = document.instances[input.cardId]?.actions[input.actionId];
    } else action = document.cards?.find(card => card.id === input.cardId)?.actions?.find(action => action.id === input.actionId);
    if (!action || action.kind !== kind) throw deviceError("DETAIL_ACTION_NOT_FOUND", 404);
    const prepared = await this.registry.prepare({ action, fields: input.fields, expectedResourceRevision: input.expectedResourceRevision,
      scope: { ...scope, cardId: input.cardId } });
    return { ...prepared, action };
  }
  async read(identity, sessionId, input, authenticate) {
    return (await this.prepareRead(identity, sessionId, input, authenticate)).value;
  }
  async prepareRead(identity, sessionId, input, authenticate) {
    validateDetailContract(input, "ActionRequest");
    canonicalDetailV2(input);
    const scope = await this.scope(identity, sessionId, authenticate, input.documentId);
    const prepared = await this.resolve(scope, input, "read");
    const result = await (prepared.action.operation === "detail.refresh" ? this.documentFor(scope, { refresh: true })
      : prepared.port.read({ ...scope, cardId: input.cardId }, prepared.target, input.fields));
    const current = await this.scope(identity, sessionId, authenticate, input.documentId);
    if (hash({ sessionId: current.sessionId, catalog: current.catalog ?? null, capabilityDigest: current.capabilityDigest ?? null })
      !== hash({ sessionId: scope.sessionId, catalog: scope.catalog ?? null, capabilityDigest: scope.capabilityDigest ?? null })) {
      throw deviceError("DETAIL_SCOPE_CHANGED", 403);
    }
    return Object.freeze({ value: result, revalidate: () => {
      scope.revalidateSync(); scope.readGuard?.();
    } });
  }
  async command(identity, sessionId, input, authenticate) {
    validateDetailContract(input, "ActionRequest");
    const scope = await this.scope(identity, sessionId, authenticate, input.documentId);
    const requestHash = hash({ principal: clientCommandPrincipalKey(scope.identity), authority: authority(scope.identity),
      sessionId: scope.sessionId, catalog: scope.catalog ?? null, capabilityDigest: scope.capabilityDigest ?? null, request: input });
    const existing = this.row(scope.identity, input.requestId);
    // Original identity is sufficient to recover a completed command even if
    // its card has vanished or its resource has since changed revision.
    if (existing) {
      if (existing.session_id !== scope.sessionId) throw deviceError("COMMAND_NOT_FOUND", 404);
      if (existing.detail_request_hash !== requestHash) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return this.commandAPI.receipt(scope.identity, input.requestId);
    }
    let prepared = await this.resolve(scope, input, "command"), dispatchScope = scope;
    const fingerprint = (prepared, scope) => hash({ requestHash, operation: prepared.action.operation, target: prepared.target, fields: input.fields,
      catalog: scope.catalog ?? null, capabilityDigest: scope.capabilityDigest ?? null });
    const payloadHash = fingerprint(prepared, scope);
    return executeClientCommand(this.commandAPI, scope.identity,
      async () => (await this.scope(scope.identity, sessionId, authenticate, input.documentId)).identity,
      { kind: `inspector:detail:${prepared.action.operation}`, entityId: scope.sessionId, sessionId: scope.sessionId,
        requestId: input.requestId, fields: input.fields, payloadHash, requestHash, strictSessionScope: true,
        executionErrorsAreUnknown: true, uncertainCode: "DETAIL_OUTCOME_UNCERTAIN",
        preflight: async () => {
          const current = await this.scope(scope.identity, sessionId, authenticate, input.documentId);
          dispatchScope = current;
          prepared = await this.resolve(current, input, "command");
          if (fingerprint(prepared, current) !== payloadHash) throw deviceError("DETAIL_ACTION_CHANGED", 409);
        },
        run: fingerprint => prepared.port.execute(dispatchScope, prepared.target, input.fields, { requestId: input.requestId, fingerprint, resource: prepared.resource }) });
  }
}
