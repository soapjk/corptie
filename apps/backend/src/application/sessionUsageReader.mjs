import { loadSessionUsageSnapshot } from "./sessionUsageSnapshot.mjs";

// Stored context usage is authoritative; account quota refresh goes through the
// shared Session application service, never a concrete Provider transport.
export function createSessionUsageReader({
  store, sessionApplicationService, publishTimeline, resetForecastForSession, readOnly = false
}) {
  /** Account quota + context usage of one Session; shared by the desktop route and the paired-device gateway. */
  function readSessionUsage(sessionId, session = store.getSession(sessionId), { requireFreshAccount = false } = {}) {
    if (!session) return Promise.reject(new Error("Session not found."));
    if (readOnly && requireFreshAccount) {
      return Promise.reject(Object.assign(new Error("Account usage refresh is disabled in read-only preview."), {
        code: "DEVELOPMENT_PREVIEW_READ_ONLY", status: 403
      }));
    }
    const logical = store.getLogicalSessionByLegacySessionId?.(sessionId);
    const route = logical?.activeBinding ?? null;
    const providerId = route?.providerId ?? session.external?.provider ?? "unknown";
    const model = session.external?.currentModel ?? null;
    const storedContext = store.getSessionContextUsage(sessionId);
    const contextMatchesRoute = storedContext
      && storedContext.providerId === providerId
      && (storedContext.model ?? null) === model
      && (!storedContext.bindingId || !route?.bindingId || storedContext.bindingId === route.bindingId);
    const storedProviderModel = store.getProviderModelUsage(providerId, model);
    const fallbackAccount = storedProviderModel?.account ?? {
      available: false, provider: providerId, model
    };
    return loadSessionUsageSnapshot({
      // A quota read can resume a Provider runtime. Preview must use only
      // stored values, including when the UI polls this GET endpoint.
      loadAccount: async () => readOnly ? null : sessionApplicationService.readAccountUsage(sessionId),
      loadContext: async () => contextMatchesRoute ? storedContext.context : null,
      fallbackAccount,
      requireFreshAccount,
      persistAccount: (account) => {
        // Adapter payload names are presentation details; ownership comes only
        // from the active route and current Session model.
        const authoritativeAccount = { ...account, provider: providerId, model };
        const result = store.upsertProviderModelUsage({
          providerId, model, account: authoritativeAccount
        });
        if (JSON.stringify(storedProviderModel?.account) !== JSON.stringify(authoritativeAccount)) {
          publishTimeline(sessionId);
        }
        return result;
      },
      resetForecast: resetForecastForSession(session)
    }).then(snapshot => ({ ...snapshot,
      account: snapshot.account ? { ...snapshot.account, provider: providerId, model } : null,
      route: {
        providerId, model, bindingId: route?.bindingId ?? null,
        routingVersion: route?.routingVersion ?? logical?.routingVersion ?? null
      }
    }));
  }

  async function getGatewayUsage(sessionId = null) {
    if (!sessionId) return { available: false, provider: "codex", model: null };
    const session = store.getSession(sessionId);
    if (!session) return { available: false, provider: "unknown", model: null };
    const logical = store.getLogicalSessionByLegacySessionId?.(sessionId);
    const providerId = logical?.activeBinding?.providerId ?? session.external?.provider ?? "unknown";
    const model = session.external?.currentModel ?? null;
    return store.getProviderModelUsage(providerId, model)?.account
      ?? { available: false, provider: providerId, model };
  }

  return { readSessionUsage, getGatewayUsage };
}
