import { createSessionToolBindingProjection } from "../../src/application/sessionToolBindingProjection.mjs";
import { createSessionToolContextResolver } from "../../src/application/sessionToolScope.mjs";

export function sessionToolTestAuthority(store) {
  const { resolveToolHostBinding } = createSessionToolBindingProjection({ store });
  return createSessionToolContextResolver({
    store, resolveToolHostBinding,
    collaborationCore: { getAgentForSession: id => ({ agentId: store.getSession(id)?.agentId }) }
  });
}

export function sessionToolTestContext(store, metadata) {
  const logical = store.getLogicalSession(metadata.sessionId)
    ?? store.getLogicalSessionByLegacySessionId(metadata.sessionId);
  const session = logical && store.getSession(logical.legacySessionId);
  return sessionToolTestAuthority(store)({
    actorId: session?.agentId,
    evidence: { kind: "session-binding", sessionId: session?.id, providerBindingId: metadata.providerBindingId }
  }).context;
}
