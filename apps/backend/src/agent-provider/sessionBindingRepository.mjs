import { CLAUDE_AGENT_SDK_PROVIDER_ID } from "./providers/claudeAgentSdkProvider.mjs";
import { CODEX_APP_SERVER_PROVIDER_ID } from "./providers/codexAppServerProvider.mjs";

// Owns the temporary translation between legacy public Session ids and the
// stable Logical Session / Agent Provider binding model. No application service
// or controller should parse codex:/pty: prefixes directly.
export class SessionBindingRepository {
  constructor(options = {}) {
    this.store = options.store;
    this.findSession = options.findSession;
    this.normalizeLegacySessionId = options.normalizeLegacySessionId ?? defaultNormalizeLegacySessionId;
    if (!this.store) throw new TypeError("SessionBindingRepository requires a store.");
    if (typeof this.findSession !== "function") {
      throw new TypeError("SessionBindingRepository requires findSession().");
    }
  }

  resolve(requestedSessionId) {
    const requested = normalizedText(requestedSessionId);
    if (!requested) return null;
    const logical = this.store.getLogicalSession(requested)
      ?? this.store.getLogicalSessionByLegacySessionId(requested);
    const legacySessionId = logical?.legacySessionId ?? requested;
    const session = this.findSession(legacySessionId) ?? this.store.getSession(legacySessionId);
    if (!session) return null;
    const binding = logical?.activeBinding ?? null;
    const providerId = binding?.providerId ?? providerIdForLegacySession(session);
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

export function providerIdForLegacySession(session) {
  const provider = normalizedText(session?.external?.provider);
  if (provider === CLAUDE_AGENT_SDK_PROVIDER_ID) return CLAUDE_AGENT_SDK_PROVIDER_ID;
  if (provider === CODEX_APP_SERVER_PROVIDER_ID) return CODEX_APP_SERVER_PROVIDER_ID;
  return CODEX_APP_SERVER_PROVIDER_ID;
}

function defaultNormalizeLegacySessionId(sessionId) {
  return sessionId.startsWith("pty:") ? sessionId.slice("pty:".length) : sessionId;
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}
