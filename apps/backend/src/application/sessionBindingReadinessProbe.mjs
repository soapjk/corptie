import { SessionPreparationCoordinator } from "./sessionPreparationCoordinator.mjs";
import { sessionReadinessStamp } from "./sessionReadinessStamp.mjs";

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
    this.preparations = new SessionPreparationCoordinator({
      resolveReference: this.resolveReference,
      verify: sessionId => this.verify(sessionId),
      reconcile: sessionId => this.verify(sessionId, { reconcileOnly: true }),
      invalidate: reference => this.invalidateBinding(reference, { preservePreparation: true }),
      onChanged: this.onChanged,
      persistence: options.preparationPersistence,
      ...options.preparationLimits
    });
  }

  readiness(logicalSessionId, bindingId) {
    const record = this.states.get(logicalSessionId);
    if (!record || record.bindingId !== bindingId) return undefined;
    return record.readiness;
  }

  async verify(sessionId, options = {}) {
    const reference = await this.resolveReference(sessionId);
    const logicalSessionId = reference.logicalSessionId ?? reference.sessionId;
    const bindingId = reference.bindingId ?? reference.providerBindingId ?? reference.providerSessionId;
    const key = `${logicalSessionId}:${bindingId}:${sessionReadinessStamp(reference)}:${options.reconcileOnly === true ? "reconcile" : "verify"}`;
    const cachedReadiness = this.readiness(logicalSessionId, bindingId);
    if (options.reuseReady === true && cachedReadiness === null
        && this.states.get(logicalSessionId)?.stamp === sessionReadinessStamp(reference)) {
      return Object.freeze({ ready: true, readiness: null, outcome: null, cached: true });
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    // Every dispatch still probes the concrete Provider binding. Once this
    // exact binding has been verified ready, keep that last known presentation
    // state while the repeated safety probe runs; publishing VERIFYING here
    // briefly replaces the macOS composer with its read-only state after every
    // message. A missing, changed, or previously failed binding still exposes
    // VERIFYING until the probe settles.
    if (this.readiness(logicalSessionId, bindingId) !== null
        || this.states.get(logicalSessionId)?.stamp !== sessionReadinessStamp(reference)) {
      this.#set(reference, bindingId, VERIFYING);
    }
    const attempt = { reference, bindingId, cancelled: false, promise: null };
    const operation = this.#verify(reference, bindingId, attempt, options).finally(() => {
      if (this.inFlight.get(key) === attempt) this.inFlight.delete(key);
    });
    attempt.promise = operation;
    this.inFlight.set(key, attempt);
    return operation;
  }

  invalidateBinding(reference, options = {}) {
    const logicalSessionId = reference?.logicalSessionId ?? reference?.sessionId;
    const bindingId = reference?.bindingId
      ?? reference?.providerBindingId
      ?? reference?.providerSessionId;
    if (!logicalSessionId || !bindingId) return false;
    if (!options.preservePreparation) this.preparations.invalidateWhere(value =>
      (value.logicalSessionId ?? value.sessionId) === logicalSessionId
      && (value.bindingId ?? value.providerBindingId ?? value.providerSessionId) === bindingId);
    this.#invalidateAttempts((attempt) =>
      (attempt.reference.logicalSessionId ?? attempt.reference.sessionId) === logicalSessionId
      && attempt.bindingId === bindingId);
    const current = this.states.get(logicalSessionId);
    if (!current || current.bindingId !== bindingId) return false;
    this.states.delete(logicalSessionId);
    this.onChanged(current.sessionId);
    return true;
  }

  invalidateProvider(providerId, options = {}) {
    // A readiness transition alone does not prove a new Provider process epoch.
    this.preparations.invalidateWhere(reference => reference.providerId === providerId,
      { runtimeChanged: options.runtimeChanged === true });
    this.#invalidateAttempts((attempt) => attempt.reference.providerId === providerId);
    for (const [logicalSessionId, record] of this.states) {
      if (record.providerId !== providerId) continue;
      this.states.delete(logicalSessionId);
      this.onChanged(record.sessionId);
    }
  }

  #invalidateAttempts(matches) {
    for (const [key, attempt] of this.inFlight) {
      if (!matches(attempt)) continue;
      attempt.cancelled = true;
      this.inFlight.delete(key);
    }
  }

  async #verify(reference, bindingId, attempt, options) {
    try {
      const outcome = await this.probe(reference.sessionId, {
        purpose: "binding-readiness-probe",
        bindingReadinessProbe: true,
        logicalSessionId: reference.logicalSessionId ?? null,
        providerBindingId: bindingId,
        ...(options.reconcileOnly === true ? { reconcileOnly: true } : {})
      });
      const current = await this.resolveReference(reference.sessionId);
      if (attempt.cancelled) return supersededVerification();
      const currentBindingId = current.bindingId
        ?? current.providerBindingId
        ?? current.providerSessionId;
      const proved = { ...reference, readinessRuntimeEpoch: outcome?.runtimeEpoch ?? reference.readinessRuntimeEpoch };
      if (currentBindingId !== bindingId || sessionReadinessStamp(proved) !== sessionReadinessStamp(current)) {
        const readiness = unavailable(
          "SESSION_BINDING_CHANGED",
          "The Provider Session binding changed while it was being verified. Please retry."
        );
        this.#set(current, currentBindingId, readiness);
        return Object.freeze({ ready: false, readiness });
      }
      if (outcome?.ready === false) {
        const readiness = unavailable(outcome.reasonCode ?? "PROVIDER_RESUME_OUTCOME_UNKNOWN",
          "The previous Provider operation cannot yet be confirmed. No message was resent.");
        this.#set(reference, bindingId, readiness);
        return Object.freeze({ ready: false, readiness, outcome: outcome ?? null });
      }
      this.#set(current, bindingId, null);
      return Object.freeze({ ready: true, readiness: null, outcome: outcome ?? null });
    } catch (error) {
      if (attempt.cancelled) return supersededVerification();
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
    const current = this.states.get(logicalSessionId);
    if (current?.bindingId === bindingId && current.readiness === readiness) return;
    this.states.set(logicalSessionId, Object.freeze({
      sessionId: reference.sessionId,
      providerId: reference.providerId,
      bindingId,
      stamp: sessionReadinessStamp(reference),
      readiness
    }));
    this.onChanged(reference.sessionId);
  }
}

function unavailable(code, message) {
  return Object.freeze({ state: "not_ready", reasonCode: code, message, retryable: true });
}

function supersededVerification() {
  return Object.freeze({ ready: false, readiness: unavailable(
    "BINDING_VERIFICATION_SUPERSEDED",
    "The Provider runtime changed during verification. Please verify this Session again."
  ) });
}

function providerUnavailableMessage(error) {
  const code = String(error?.code ?? "");
  if (code === "PROVIDER_RPC_TIMEOUT") {
    return "Provider Session verification timed out; the remote result is unknown. Retry verification without resending the message.";
  }
  if ([
    "PROVIDER_SESSION_UNAVAILABLE", "PROVIDER_EMPTY_THREAD_UNRECOVERABLE",
    "SESSION_NOT_FOUND", "THREAD_NOT_FOUND"
  ].includes(code)) {
    return "The Provider Session no longer exists or cannot be reached. Retry or recover this Session.";
  }
  const message = String(error?.message ?? "").replace(/\s+/g, " ").trim();
  return message || "The Provider Session is unavailable. Please retry.";
}
