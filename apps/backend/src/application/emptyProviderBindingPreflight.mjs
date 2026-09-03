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
    this.recoverUnavailable = options.recoverUnavailable ?? null;
    this.isUnavailable = options.isUnavailable ?? (() => false);
    this.onChanged = options.onChanged ?? (() => {});
    this.concurrency = positiveInteger(options.concurrency ?? 2, "concurrency");
    this.pending = new Map();
    this.candidates = new Map();
    this.inFlight = new Map();
    if (!this.store?.listEmptyActiveProviderBindings) {
      throw new TypeError("Empty Provider Binding preflight requires a Session Store.");
    }
    if (typeof this.ensureUsable !== "function") {
      throw new TypeError("Empty Provider Binding preflight requires ensureUsable().");
    }
  }

  /// Runs after the loopback listener opens, while the Provider is still
  /// globally Not Ready. Candidate discovery is one indexed Store query, so
  /// it can never turn application connection into an N+1 startup gate.
  prepare() {
    const candidates = this.store.listEmptyActiveProviderBindings(this.providerId)
      .map((candidate) => Object.freeze({ ...candidate }));
    for (const candidate of candidates) {
      this.pending.set(candidate.logicalSessionId, DEFAULT_REASON);
      this.candidates.set(candidate.logicalSessionId, candidate);
    }
    return Object.freeze({ candidates: candidates.length });
  }

  readiness(logicalSessionId) {
    return this.pending.get(logicalSessionId) ?? null;
  }

  async recover(logicalSessionId) {
    const candidate = this.candidates.get(logicalSessionId);
    if (!candidate) return Object.freeze({ status: "not_pending" });
    const existing = this.inFlight.get(logicalSessionId);
    if (existing) return existing;
    const operation = this.#recover(candidate).finally(() => {
      this.inFlight.delete(logicalSessionId);
    });
    this.inFlight.set(logicalSessionId, operation);
    return operation;
  }

  async run() {
    const logicalSessionIds = [...this.candidates.keys()];
    let cursor = 0;
    const results = new Array(logicalSessionIds.length);
    const worker = async () => {
      while (cursor < logicalSessionIds.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await this.recover(logicalSessionIds[index]);
        } catch (error) {
          results[index] = Object.freeze({
            logicalSessionId: logicalSessionIds[index],
            status: "failed",
            code: error?.code ?? "BINDING_RUNTIME_RECOVERY_FAILED"
          });
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.concurrency, logicalSessionIds.length) },
      () => worker()
    ));
    return Object.freeze({
      scanned: logicalSessionIds.length,
      ready: results.filter((result) => result.status === "ready").length,
      failed: results.filter((result) => result.status === "failed").length,
      results: Object.freeze(results)
    });
  }

  async #recover(candidate) {
    try {
      let activeCandidate = candidate;
      let replacement = null;
      let outcome;
      try {
        outcome = await this.ensureUsable(activeCandidate);
      } catch (error) {
        if (typeof this.recoverUnavailable !== "function" || !this.isUnavailable(error)) {
          throw error;
        }
        replacement = await this.recoverUnavailable(candidate, error);
        activeCandidate = Object.freeze({ ...candidate, ...(replacement?.candidate ?? replacement ?? {}) });
        // Replacement is not considered successful until the newly committed
        // Provider route passes the same authoritative runtime verification.
        outcome = await this.ensureUsable(activeCandidate);
      }
      this.pending.delete(candidate.logicalSessionId);
      this.candidates.delete(candidate.logicalSessionId);
      this.onChanged(candidate, null);
      return Object.freeze({
        ...activeCandidate,
        status: "ready",
        recovered: replacement !== null,
        outcome: outcome ?? null
      });
    } catch (error) {
      const readiness = Object.freeze({
        state: "not_ready",
        reasonCode: error?.code ?? "BINDING_RUNTIME_RECOVERY_FAILED",
        message: error?.message ?? "Session binding recovery failed.",
        retryable: true
      });
      this.pending.set(candidate.logicalSessionId, readiness);
      this.onChanged(candidate, readiness);
      throw error;
    }
  }
}

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return normalized;
}
