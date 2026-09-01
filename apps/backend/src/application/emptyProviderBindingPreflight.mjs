const DEFAULT_REASON = Object.freeze({
  state: "not_ready",
  reasonCode: "BINDING_RUNTIME_VERIFYING",
  message: "Session binding is being verified after the Provider restarted.",
  retryable: true
});

export class EmptyProviderBindingPreflight {
  constructor(options = {}) {
    this.store = options.store;
    this.providerId = options.providerId;
    this.ensureUsable = options.ensureUsable;
    this.onChanged = options.onChanged ?? (() => {});
    this.concurrency = positiveInteger(options.concurrency ?? 2, "concurrency");
    this.pending = new Map();
    this.prepared = [];
    if (!this.store?.listSessions
      || !this.store?.getLogicalSessionByLegacySessionId
      || !this.store?.hasSessionTurnForBinding) {
      throw new TypeError("Empty Provider Binding preflight requires a Session Store.");
    }
    if (typeof this.ensureUsable !== "function") {
      throw new TypeError("Empty Provider Binding preflight requires ensureUsable().");
    }
  }

  /// Must run before the loopback listener opens. This is a Store-only scan:
  /// it marks risky zero-Turn bindings Not Ready without touching a Provider.
  prepare() {
    const candidates = [];
    for (const session of this.store.listSessions({ archived: false })) {
      const logical = this.store.getLogicalSessionByLegacySessionId(session.id);
      const binding = logical?.activeBinding ?? null;
      if (!binding || binding.state !== "active" || logical.archived
        || logical.transitionState || binding.providerId !== this.providerId) continue;
      if (this.store.hasSessionTurnForBinding(session.id, binding.bindingId)) continue;
      const candidate = Object.freeze({
        sessionId: session.id,
        logicalSessionId: logical.logicalSessionId,
        bindingId: binding.bindingId,
        providerId: binding.providerId,
        providerSessionId: binding.providerSessionId
      });
      candidates.push(candidate);
      this.pending.set(logical.logicalSessionId, DEFAULT_REASON);
    }
    this.prepared = candidates;
    return Object.freeze({ candidates: candidates.length });
  }

  readiness(logicalSessionId) {
    return this.pending.get(logicalSessionId) ?? null;
  }

  async run() {
    const candidates = [...this.prepared];
    let cursor = 0;
    const results = new Array(candidates.length);
    const worker = async () => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        const candidate = candidates[index];
        try {
          const outcome = await this.ensureUsable(candidate);
          this.pending.delete(candidate.logicalSessionId);
          this.onChanged(candidate, null);
          results[index] = Object.freeze({ ...candidate, status: "ready", outcome: outcome ?? null });
        } catch (error) {
          const readiness = Object.freeze({
            state: "not_ready",
            reasonCode: error?.code ?? "BINDING_RUNTIME_RECOVERY_FAILED",
            message: error?.message ?? "Session binding recovery failed.",
            retryable: true
          });
          this.pending.set(candidate.logicalSessionId, readiness);
          this.onChanged(candidate, readiness);
          results[index] = Object.freeze({
            ...candidate,
            status: "failed",
            code: readiness.reasonCode
          });
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.concurrency, candidates.length) },
      () => worker()
    ));
    return Object.freeze({
      scanned: candidates.length,
      ready: results.filter((result) => result.status === "ready").length,
      failed: results.filter((result) => result.status === "failed").length,
      results: Object.freeze(results)
    });
  }
}

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return normalized;
}
