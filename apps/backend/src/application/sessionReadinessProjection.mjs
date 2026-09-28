import { withResolvedSessionActions } from "../agent-provider/sessionActions.mjs";
import { withSessionReadiness } from "./sessionReadiness.mjs";

// Owns transient Provider readiness and projects it through the durable Session
// revision stream. Probe ownership remains with the runtime lifecycle.
export function createSessionReadinessProjection({
  store, agentProviderRegistry, scheduleStateSyncPublish,
  readBindingProbe, readFallbackBindingReadiness
}) {
  const providerRuntimeReadiness = new Map(agentProviderRegistry.descriptors().map((provider) => [
    provider.id,
    {
      state: "not_ready",
      reasonCode: "PROVIDER_INITIALIZING",
      message: `${provider.displayName} is preparing to accept Session messages.`,
      retryable: true
    }
  ]));

  function setProviderRuntimeReadiness(providerId, readiness) {
    const resolved = agentProviderRegistry.resolveId(providerId) ?? providerId;
    const previous = providerRuntimeReadiness.get(resolved) ?? null;
    if (JSON.stringify(previous) === JSON.stringify(readiness)) return;
    if (readiness?.state !== "ready") {
      readBindingProbe()?.invalidateProvider(resolved);
    }
    providerRuntimeReadiness.set(resolved, readiness);

    // Runtime readiness is part of the client-visible Session projection even
    // though it is not stored on the Session row. Merely scheduling State Sync
    // is insufficient: clients whose durable cursor already equals the Store
    // revision receive no frame and remain stuck with the startup `not_ready`
    // projection. Touch every affected Session's projection dependency so the
    // ordinary revision log publishes provider-neutral Session upserts.
    const affectedSessionIds = store.listSessions({ archived: false })
      .filter((session) => {
        const identity = session.external?.provider ?? session.provider ?? null;
        return identity && agentProviderRegistry.resolveId(identity) === resolved;
      })
      .map((session) => session.id);
    for (const sessionId of affectedSessionIds) {
      store.touchSessionProjectionDependency(sessionId);
    }
    if (affectedSessionIds.length === 0) scheduleStateSyncPublish();
  }

  function decorateSessionForClient(session, options = {}) {
    if (!session) return session;
    const decorated = withResolvedSessionActions(session, agentProviderRegistry);
    const providerIdentity = decorated.external?.provider ?? decorated.provider ?? null;
    const providerId = providerIdentity ? agentProviderRegistry.resolveId(providerIdentity) : null;
    const logical = decorated.logicalSessionId
      ? store.getLogicalSession(decorated.logicalSessionId)
      : store.getLogicalSessionByLegacySessionId(decorated.id);
    const binding = logical?.activeBinding ?? null;
    const toolMaterialization = logical?.logicalSessionId && binding?.bindingId
      ? store.getSessionToolCatalogMaterialization(logical.logicalSessionId, binding.bindingId)
      : null;
    return withSessionReadiness(decorated, {
      logicalSession: logical,
      requireActiveBinding: options.requireActiveBinding !== false,
      providerRuntime: providerId ? providerRuntimeReadiness.get(providerId) : null,
      bindingRuntime: bindingRuntimeReadiness(logical, binding),
      toolMaterialization,
      readOnly: options.readOnly === true
    });
  }

  function bindingRuntimeReadiness(logical, binding) {
    if (!logical?.logicalSessionId) return null;
    const probed = readBindingProbe()?.readiness(
      logical.logicalSessionId,
      binding?.bindingId ?? binding?.providerThreadId ?? null
    );
    return probed === undefined
      ? readFallbackBindingReadiness(logical.logicalSessionId)
      : probed;
  }
  return { setProviderRuntimeReadiness, decorateSessionForClient };
}
