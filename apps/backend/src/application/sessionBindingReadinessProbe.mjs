const VERIFYING = Object.freeze({
  state: "not_ready",
  reasonCode: "BINDING_RUNTIME_VERIFYING",
  message: "The Provider Session binding is being verified.",
  retryable: true
});

export class SessionBindingReadinessProbe {
  constructor(options = {}) {
    this.resolveReference = options.resolveReference;
    this.probe = options.probe;
    this.onChanged = options.onChanged ?? (() => {});
    this.states = new Map();
    this.inFlight = new Map();
    if (typeof this.resolveReference !== "function" || typeof this.probe !== "function") {
      throw new TypeError("Session binding readiness requires resolveReference() and probe().");
    }
  }

  readiness(logicalSessionId, bindingId) {
    const record = this.states.get(logicalSessionId);
    if (!record || record.bindingId !== bindingId) return undefined;
    return record.readiness;
  }

  async verify(sessionId) {
    const reference = await this.resolveReference(sessionId);
    const logicalSessionId = reference.logicalSessionId ?? reference.sessionId;
    const bindingId = reference.bindingId ?? reference.providerBindingId ?? reference.providerSessionId;
    const key = `${logicalSessionId}:${bindingId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    this.#set(reference, bindingId, VERIFYING);
    const operation = this.#verify(reference, bindingId).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  invalidateProvider(providerId) {
    for (const [logicalSessionId, record] of this.states) {
      if (record.providerId !== providerId) continue;
      this.states.delete(logicalSessionId);
      this.onChanged(record.sessionId);
    }
  }

  async #verify(reference, bindingId) {
    try {
      const outcome = await this.probe(reference.sessionId, {
        purpose: "binding-readiness-probe",
        bindingReadinessProbe: true,
        logicalSessionId: reference.logicalSessionId ?? null,
        providerBindingId: bindingId
      });
      const current = await this.resolveReference(reference.sessionId);
      const currentBindingId = current.bindingId
        ?? current.providerBindingId
        ?? current.providerSessionId;
      if (currentBindingId !== bindingId) {
        const readiness = unavailable(
          "SESSION_BINDING_CHANGED",
          "The Provider Session binding changed while it was being verified. Please retry."
        );
        this.#set(current, currentBindingId, readiness);
        return Object.freeze({ ready: false, readiness });
      }
      this.#set(reference, bindingId, null);
      return Object.freeze({ ready: true, readiness: null, outcome: outcome ?? null });
    } catch (error) {
      const readiness = unavailable(
        error?.code ?? "PROVIDER_SESSION_UNAVAILABLE",
        providerUnavailableMessage(error)
      );
      this.#set(reference, bindingId, readiness);
      return Object.freeze({ ready: false, readiness });
    }
  }

  #set(reference, bindingId, readiness) {
    const logicalSessionId = reference.logicalSessionId ?? reference.sessionId;
    this.states.set(logicalSessionId, Object.freeze({
      sessionId: reference.sessionId,
      providerId: reference.providerId,
      bindingId,
      readiness
    }));
    this.onChanged(reference.sessionId);
  }
}

function unavailable(code, message) {
  return Object.freeze({ state: "not_ready", reasonCode: code, message, retryable: true });
}

function providerUnavailableMessage(error) {
  const code = String(error?.code ?? "");
  if ([
    "PROVIDER_SESSION_UNAVAILABLE", "PROVIDER_EMPTY_THREAD_UNRECOVERABLE",
    "SESSION_NOT_FOUND", "THREAD_NOT_FOUND"
  ].includes(code)) {
    return "The Provider Session no longer exists or cannot be reached. Retry or recover this Session.";
  }
  const message = String(error?.message ?? "").replace(/\s+/g, " ").trim();
  return message || "The Provider Session is unavailable. Please retry.";
}
