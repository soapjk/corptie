export function resolveStableSessionIdForProviderDetail({
  store,
  providerId,
  physicalSessionId
}) {
  const provider = String(providerId ?? "").trim();
  const raw = String(physicalSessionId ?? "").trim();
  if (!provider || !raw) return null;

  const prefix = `${provider}:`;
  const physical = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const prefixed = raw.startsWith(prefix) ? raw : `${prefix}${physical}`;
  const logical = store.getLogicalSessionByLegacySessionId(raw)
    ?? store.getLogicalSessionByLegacySessionId(prefixed)
    ?? store.getLogicalSessionByProviderSessionId(provider, physical)
    ?? store.getLogicalSessionByProviderThreadId(physical);
  if (logical?.legacySessionId) return logical.legacySessionId;

  // Older/provider-only Sessions may not have a Logical Session route yet.
  // Resolve against the durable inventory instead of returning the physical id
  // and relying on a foreign-key failure to reveal the mismatch.
  if (store.getSession(raw)) return raw;
  if (store.getSession(prefixed)) return prefixed;
  return null;
}
