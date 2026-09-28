import { isProductSessionKind } from "../utils/sessionKinds.mjs";
import { mergeStoredSessionPresentation } from "../utils/sessionPresentation.mjs";

export function createManagedProviderSessionProjection({
  store, collaborationCore, sessionWithLogicalWorkspace,
  workspaceRoutePreparationCache, getStartupReceipt,
  reportedUnclassifiedProviderSessionIds, now, emitEvent
}) {
  function resolveProviderEventBinding(event) {
    const binding = store.getAgentSessionBinding(event.bindingId);
    if (!binding) return null;
    const logical = store.getLogicalSession(binding.logicalSessionId);
    if (!logical?.legacySessionId) return null;
    let startup = null;
    try { startup = getStartupReceipt(binding.logicalSessionId); } catch { /* Missing startup proof is not a route. */ }
    const materialization = store.getSessionToolCatalogMaterialization(binding.logicalSessionId, binding.bindingId);
    const toolHostAppliedReceipt = materialization?.status === "applied" ? materialization.providerReceipt : null;
    return {
      ...binding,
      providerMetadata: {
        ...(binding.providerMetadata ?? {}),
        ...(startup ? {
          startupBindingReceipt: startup,
          startupProviderBindingMapping: {
            startupProviderBindingId: startup.providerBindingId,
            providerBindingId: binding.bindingId,
            startupBindingGeneration: startup.bindingGeneration,
            providerBindingGeneration: binding.routingVersion
          }
        } : {}),
        ...(toolHostAppliedReceipt ? { toolHostAppliedReceipt } : {})
      },
      sessionId: logical.legacySessionId,
      isCurrentRoute: logical.activeBinding?.bindingId === binding.bindingId
    };
  }

  function ensureCollaborationAgentForSession(session, preferredAgentId = null) {
    if (!store.db || !session?.id) return null;
    // Agent records are user-owned: bind only an existing Agent to the Session.
    const bound = collaborationCore.getAgentForSession(session.id);
    const agentId = preferredAgentId ?? bound?.agentId;
    if (!agentId) return null;
    const agent = collaborationCore.getAgent(agentId);
    if (!agent) return null;
    collaborationCore.bindSession({ agentId, sessionId: session.id });
    return agent;
  }

  function upsertManagedCodexSession(session, preferredAgentId = null) {
    const stored = store.getSession(session.id);
    // Persist durable product associations before publishing an in-memory
    // Provider projection, so validation failure cannot advance the cache.
    const managedSession = mergeStoredSessionPresentation(session, stored);
    const sessionKind = stored?.sessionKind ?? managedSession.sessionKind;
    if (!isProductSessionKind(sessionKind)) {
      if (!reportedUnclassifiedProviderSessionIds.has(session.id)) {
        reportedUnclassifiedProviderSessionIds.add(session.id);
        console.warn(`[session-classification] skipped unclassified Codex projection session=${session.id}`);
      }
      return null;
    }
    store.upsertSession({
      ...managedSession,
      sessionKind,
      provider: managedSession.external?.provider ?? "codex-app-server",
      cwd: managedSession.external?.cwd,
      command: managedSession.external?.source ?? "codex-app-server"
    });
    ensureCollaborationAgentForSession(managedSession, preferredAgentId);
    return managedSession;
  }

  async function commitManagedCodexWorkspaceRoute(event) {
    const logical = store.getLogicalSession(event.logicalSessionId);
    const legacySessionId = logical?.legacySessionId;
    if (!legacySessionId) return;
    workspaceRoutePreparationCache.invalidate(logical.logicalSessionId);
    const previous = store.getSession(legacySessionId);
    if (!previous) return;
    const session = sessionWithLogicalWorkspace({
      ...previous,
      updatedAt: now(),
      external: { ...(previous.external ?? {}), activeTurnId: null }
    }, logical);
    upsertManagedCodexSession(session);
    emitEvent("SessionWorkspaceSwitched", { session, ...event }, { sessionId: legacySessionId });
  }

  return {
    resolveProviderEventBinding, ensureCollaborationAgentForSession,
    upsertManagedCodexSession, commitManagedCodexWorkspaceRoute
  };
}
