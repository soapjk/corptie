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

// Product events may originate at provider-neutral boundaries that expose a
// Logical Session id. Durable timeline and outbox tables deliberately retain
// their foreign key to the concrete sessions row, so normalize that identity
// before entering the persistence transaction. An unavailable/tombstoned
// route still produces a global product event, but must not make the primary
// operation fail with an opaque SQLite foreign-key error.
export function resolveDurableEventSessionId(store, requestedSessionId) {
  const requested = String(requestedSessionId ?? "").trim();
  if (!requested) return null;
  if (store.getSession(requested)) return requested;

  const logical = store.getLogicalSession(requested)
    ?? store.getLogicalSessionByLegacySessionId(requested);
  const durableSessionId = String(logical?.legacySessionId ?? "").trim();
  return durableSessionId && store.getSession(durableSessionId)
    ? durableSessionId
    : null;
}
