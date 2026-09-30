import { loadSessionUsageSnapshot } from "./sessionUsageSnapshot.mjs";

// Stored context usage is authoritative; account quota refresh goes through the
// shared Session application service, never a concrete Provider transport.
export function createSessionUsageReader({
  store, sessionApplicationService, publishTimeline, resetForecastForSession
}) {
  /** Account quota + context usage of one Session; shared by the desktop route and the paired-device gateway. */
  function readSessionUsage(sessionId, session = store.getSession(sessionId), { requireFreshAccount = false } = {}) {
    if (!session) return Promise.reject(new Error("Session not found."));
    const provider = session.external?.provider === "codex-app-server"
      ? "codex"
      : session.external?.provider ?? "unknown";
    const storedUsage = store.getSessionUsageSnapshot(sessionId);
    return loadSessionUsageSnapshot({
      loadAccount: () => sessionApplicationService.readAccountUsage(sessionId),
      loadContext: async () => storedUsage?.context ?? null,
      fallbackAccount: storedUsage?.account ?? {
        available: false,
        provider,
        model: storedUsage?.model ?? session.external?.currentModel ?? null
      },
      requireFreshAccount,
      persistAccount: (account) => {
        const result = store.upsertSessionUsageSnapshot({
          sessionId,
          providerId: session.external?.provider ?? provider,
          model: account.model ?? storedUsage?.model ?? session.external?.currentModel ?? null,
          account
        });
        if (JSON.stringify(storedUsage?.account) !== JSON.stringify(account)) {
          publishTimeline(sessionId);
        }
        return result;
      },
      resetForecast: resetForecastForSession(session)
    });
  }

  async function getGatewayUsage(sessionId = null) {
    if (!sessionId) return { available: false, provider: "codex", model: null };
    const session = store.getSession(sessionId);
    if (!session) return { available: false, provider: "unknown", model: null };
    const usage = store.getSessionUsageSnapshot(sessionId);
    return usage?.account ?? {
      available: false,
      provider: session.external?.provider ?? "unknown",
      model: usage?.model ?? session.external?.currentModel ?? null
    };
  }

  return { readSessionUsage, getGatewayUsage };
}
