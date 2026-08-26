// Owns the temporary translation between legacy public Session ids and the
// stable Logical Session / Agent Provider binding model. No application service
// or controller should parse codex:/pty: prefixes directly.
export class SessionBindingRepository {
  constructor(options = {}) {
    this.store = options.store;
    this.normalizeLegacySessionId = options.normalizeLegacySessionId ?? defaultNormalizeLegacySessionId;
    this.resolveProviderId = options.resolveProviderId ?? defaultResolveProviderId;
    if (!this.store) throw new TypeError("SessionBindingRepository requires a store.");
  }

  resolve(requestedSessionId) {
    const requested = normalizedText(requestedSessionId);
    if (!requested) return null;
    const logical = this.store.getLogicalSession(requested)
      ?? this.store.getLogicalSessionByLegacySessionId(requested);
    const legacySessionId = logical?.legacySessionId ?? requested;
    // Binding resolution is on every command and Timeline request path. It is
    // an indexed point read; constructing the complete Session collection here
    // turns active background sync into an N-by-N query loop.
    const session = this.store.getSession(legacySessionId);
    if (!session) return null;
    const binding = logical?.activeBinding ?? null;
    const providerId = binding?.providerId ?? providerIdForLegacySession(session, this.resolveProviderId);
    const providerSessionId = binding?.providerSessionId
      ?? session.external?.threadId
      ?? session.external?.sessionId
      ?? this.normalizeLegacySessionId(legacySessionId);
    if (!providerId || !providerSessionId) return null;
    return {
      sessionId: legacySessionId,
      logicalSessionId: logical?.logicalSessionId ?? null,
      requestedSessionId: requested,
      bindingId: binding?.bindingId ?? null,
      providerId,
      providerSessionId,
      routingVersion: logical?.routingVersion ?? null,
      metadata: {
        session,
        providerMetadata: binding?.providerMetadata ?? {},
        legacySessionId
      }
    };
  }

  resolveBinding(requestedSessionId, bindingId) {
    const active = this.resolve(requestedSessionId);
    const normalizedBindingId = normalizedText(bindingId);
    if (!active?.logicalSessionId || !normalizedBindingId) return null;
    const binding = this.store.listProviderThreadBindings(active.logicalSessionId)
      .find((candidate) => candidate.bindingId === normalizedBindingId);
    if (!binding?.providerId || !binding?.providerSessionId) return null;
    return {
      ...active,
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      providerSessionId: binding.providerSessionId,
      routingVersion: binding.routingVersion,
      metadata: {
        ...active.metadata,
        providerMetadata: binding.providerMetadata ?? {},
        binding,
        historical: binding.state !== "active"
      }
    };
  }
}

export function providerIdForLegacySession(session, resolveProviderId = defaultResolveProviderId) {
  const provider = normalizedText(session?.external?.provider);
  return resolveProviderId(provider, { useDefault: true }) ?? null;
}

function defaultNormalizeLegacySessionId(sessionId) {
  return sessionId.startsWith("pty:") ? sessionId.slice("pty:".length) : sessionId;
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultResolveProviderId(providerId) {
  return normalizedText(providerId) || null;
}
