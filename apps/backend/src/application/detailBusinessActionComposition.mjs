import { DetailActionService, createDetailActionRegistry } from "./detailActionService.mjs";
import { createDetailBusinessActionPorts } from "./detailBusinessActionPorts.mjs";
import { detailV2CatalogOptions } from "./detailV2Catalog.mjs";
import { detailV2Hash } from "./detailSyncV2.mjs";
import { deviceError } from "./clientDeviceAuthority.mjs";
import { DETAIL_NATIVE_BUSINESS_PROFILE } from "./detailNativeBusinessContract.mjs";

/** One host-owned action profile, never inferred from an ActionRequest. A
 * negotiation binding must select a new service instead of mutating this one. */
export function createDetailBusinessActionService({ commandAPI, inspector, documentService,
  catalog = "native-v2", clientCapabilities = [] }) {
  const native = catalog === DETAIL_NATIVE_BUSINESS_PROFILE;
  if (native && clientCapabilities.length) throw deviceError("DETAIL_CAPABILITIES_INVALID", 400);
  const profile = native ? { catalog, clientCapabilities: [] } : detailV2CatalogOptions({ catalog, clientCapabilities });
  const ports = createDetailBusinessActionPorts({ inspector, schedules: inspector.schedules });
  if (native) ports["artifact.content"] = {
    authorize: (scope, target) => Boolean(inspector.artifact(inspector.scope(scope.sessionId, scope.identity), target.id)),
    validateQuery: (scope, target, fields) => {
      const action = scope.nativeDocument?.cards.flatMap(card => card.actions).find(action => action.operation === "artifact.content" && action.target.id === target.id);
      return action?.expectedResourceRevision === `${fields.version}:${fields.contentHash}`;
    },
    read: (scope, target, fields) => {
      const current = inspector.scope(scope.sessionId, scope.identity);
      if (scope.identity.principalId === "local-user" && !scope.identity.deviceId) current.context = { ...current.context, actorId: scope.identity.principalId };
      return inspector.artifacts.get(current.context, target.id, { version: fields.version, contentHash: fields.contentHash,
        offset: fields.offset, limit: 65536, turnExecutionId: `native-detail:${fields.readId}` });
    }
  };
  ports["detail.collection.page"] = {
    authorize: (scope, target) => target.resourceType === "session" && target.id === scope.sessionId,
    validateQuery: (scope, _target, fields) => {
      documentService[native ? "nativePageContext" : "richPageContext"](scope.sessionId, { authenticate: scope.revalidateSync, ...profile,
        cardId: scope.cardId, ...fields }); return true;
    },
    read: (scope, _target, fields) => documentService[native ? "nativeBusinessPage" : "richBusinessPage"](scope.sessionId, {
      authenticate: scope.revalidateSync, ...profile, cardId: scope.cardId, ...fields })
  };
  const service = new DetailActionService({ commandAPI,
    registry: createDetailActionRegistry(ports),
    authorizeScope: (identity, sessionId) => {
      const current = inspector.scope(sessionId, identity);
      const canonical = current.logicalSessionId ?? current.sessionId;
      if (!native && !documentService.acceptsDeliveryCatalog(profile.catalog)) throw deviceError("DETAIL_CATALOG_UNSUPPORTED", 409);
      return { sessionId: canonical, ...profile, capabilityDigest: detailV2Hash(profile.clientCapabilities) };
    },
    documentFor: async (scope, { refresh = false } = {}) => {
      if (native) {
        const prepared = await documentService[refresh ? "prepareNativeBusiness" : "nativeActionDocument"](scope.sessionId, scope.revalidateSync);
        prepared.revalidate(); scope.readGuard = prepared.revalidate; scope.nativeDocument = prepared.state; return prepared.state;
      }
      if (profile.catalog === "native-v2") {
        const state = documentService.v2Snapshot(scope.sessionId, { identity: scope.identity, ...profile });
        const journal = documentService.v2Journal(scope.sessionId, { identity: scope.identity, ...profile });
        scope.readGuard = () => {
          const current = inspector.scope(scope.sessionId, scope.revalidateSync());
          if ((current.logicalSessionId ?? current.sessionId) !== scope.sessionId || journal.detailRetired) {
            throw deviceError("DETAIL_READ_INVALIDATED", 409);
          }
        };
        return state;
      }
      const prepared = await documentService[refresh ? "prepareRichSnapshot" : "prepareRichActionSnapshot"](scope.sessionId,
        { authenticate: scope.revalidateSync, ...profile });
      prepared.revalidate(); scope.readGuard = prepared.revalidate; return prepared.state;
    }
  });
  service.forProfile = next => createDetailBusinessActionService({ commandAPI, inspector, documentService, ...next });
  return service;
}
