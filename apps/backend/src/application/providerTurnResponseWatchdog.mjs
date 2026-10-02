const DEFAULT_WARNING_AFTER_MS = 20_000;
const DEFAULT_TIMEOUT_AFTER_MS = 120_000;
const DEFAULT_ABSOLUTE_TIMEOUT_AFTER_MS = 30 * 60_000;

const SUBSTANTIVE_EVENT_TYPES = new Set([
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "approval.requested"
]);

const TERMINAL_EVENT_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled"
]);

const ACTIVITY_EVENT_TYPES = new Set([
  ...SUBSTANTIVE_EVENT_TYPES,
  "provider.activity"
]);

/**
 * Provider-neutral response-activity watchdog.
 *
 * The warning covers a silent start, the rolling timeout covers a stalled
 * stream, and the absolute timeout prevents retries or heartbeats from keeping
 * a Turn alive forever.
 */
export class ProviderTurnResponseWatchdog {
  constructor(options = {}) {
    this.warningAfterMs = positiveDelay(options.warningAfterMs, DEFAULT_WARNING_AFTER_MS);
    this.timeoutAfterMs = positiveDelay(options.timeoutAfterMs, DEFAULT_TIMEOUT_AFTER_MS);
    this.absoluteTimeoutAfterMs = positiveDelay(
      options.absoluteTimeoutAfterMs,
      Math.max(DEFAULT_ABSOLUTE_TIMEOUT_AFTER_MS, this.timeoutAfterMs * 2)
    );
    if (this.timeoutAfterMs <= this.warningAfterMs) {
      throw new TypeError("Provider response timeout must be greater than its warning delay.");
    }
    if (this.absoluteTimeoutAfterMs <= this.timeoutAfterMs) {
      throw new TypeError("Provider absolute timeout must be greater than its inactivity timeout.");
    }
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.onDelayed = options.onDelayed ?? (() => {});
    this.onTimeout = options.onTimeout ?? (() => {});
    this.pending = new Map();
    this.resolved = new Set();
    this.maximumResolvedKeys = options.maximumResolvedKeys ?? 4_096;
  }

  watch(input = {}) {
    const entry = normalizedEntry(input);
    const key = turnKey(entry);
    if (this.resolved.has(key) || this.pending.has(key)) return false;

    const warningTimer = this.schedule(() => {
      const current = this.pending.get(key);
      if (!current) return;
      current.warningTimer = null;
      this.#invoke(this.onDelayed, current);
    }, this.warningAfterMs);
    const timeoutTimer = this.#scheduleTimeout(key, this.timeoutAfterMs, "inactivity");
    const absoluteTimeoutTimer = this.#scheduleTimeout(
      key,
      this.absoluteTimeoutAfterMs,
      "absolute"
    );
    warningTimer?.unref?.();
    timeoutTimer?.unref?.();
    absoluteTimeoutTimer?.unref?.();
    this.pending.set(key, { ...entry, warningTimer, timeoutTimer, absoluteTimeoutTimer,
      hasActivity: false, lastActivityAt: null });
    return true;
  }

  observe({ event, binding } = {}) {
    if (!event?.turnId || !binding?.bindingId) return false;
    const entry = {
      sessionId: binding.sessionId,
      logicalSessionId: binding.logicalSessionId ?? null,
      providerId: event.providerId,
      providerSessionId: event.providerSessionId,
      bindingId: event.bindingId,
      routingVersion: event.routingVersion,
      turnId: event.turnId,
      startedAt: event.occurredAt ?? event.receivedAt ?? null
    };
    if (event.type === "turn.started") return this.watch(entry);

    const key = turnKey(entry);
    if (event.type === "provider.error" && event.payload?.willRetry === true) {
      const current = this.pending.get(key);
      if (event.payload?.error?.code === "PROVIDER_RESPONSE_DELAYED") return Boolean(current);
      return current ? this.#recordActivity(key, current, event) : false;
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) return this.resolve(entry);
    if (ACTIVITY_EVENT_TYPES.has(event.type)) {
      const current = this.pending.get(key);
      return current ? this.#recordActivity(key, current, event) : false;
    }
    return false;
  }

  resolve(input = {}) {
    const entry = normalizedEntry(input);
    const key = turnKey(entry);
    const current = this.pending.get(key);
    if (current) {
      if (current.warningTimer) this.cancel(current.warningTimer);
      if (current.timeoutTimer) this.cancel(current.timeoutTimer);
      if (current.absoluteTimeoutTimer) this.cancel(current.absoluteTimeoutTimer);
      this.pending.delete(key);
    }
    this.#rememberResolved(key);
    return Boolean(current);
  }

  close() {
    for (const current of this.pending.values()) {
      if (current.warningTimer) this.cancel(current.warningTimer);
      if (current.timeoutTimer) this.cancel(current.timeoutTimer);
      if (current.absoluteTimeoutTimer) this.cancel(current.absoluteTimeoutTimer);
    }
    this.pending.clear();
    this.resolved.clear();
  }

  #rememberResolved(key) {
    this.resolved.add(key);
    while (this.resolved.size > this.maximumResolvedKeys) {
      this.resolved.delete(this.resolved.values().next().value);
    }
  }

  #invoke(callback, entry) {
    queueMicrotask(() => Promise.resolve(callback(publicEntry(entry))).catch((error) => {
      console.error(`[provider-response-watchdog] callback failed: ${error?.message ?? error}`);
    }));
  }

  #recordActivity(key, current, event) {
    if (current.warningTimer) {
      this.cancel(current.warningTimer);
      current.warningTimer = null;
    }
    if (current.timeoutTimer) this.cancel(current.timeoutTimer);
    current.hasActivity = true;
    current.lastActivityAt = event.occurredAt ?? event.receivedAt ?? new Date().toISOString();
    const retryAfterMs = Number(event.payload?.retryAfterMs);
    const inactivityDelay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.max(this.timeoutAfterMs, Math.min(this.absoluteTimeoutAfterMs, retryAfterMs + 5_000))
      : this.timeoutAfterMs;
    current.timeoutTimer = this.#scheduleTimeout(key, inactivityDelay, "inactivity");
    current.timeoutTimer?.unref?.();
    return true;
  }

  #scheduleTimeout(key, delay, timeoutKind) {
    return this.schedule(() => {
      const current = this.pending.get(key);
      if (!current) return;
      this.pending.delete(key);
      if (current.warningTimer) this.cancel(current.warningTimer);
      if (current.timeoutTimer) this.cancel(current.timeoutTimer);
      if (current.absoluteTimeoutTimer) this.cancel(current.absoluteTimeoutTimer);
      current.warningTimer = null;
      current.timeoutTimer = null;
      current.absoluteTimeoutTimer = null;
      current.timeoutKind = timeoutKind;
      this.#rememberResolved(key);
      this.#invoke(this.onTimeout, current);
    }, delay);
  }
}

function normalizedEntry(input) {
  const entry = {
    sessionId: requiredText(input.sessionId, "sessionId"),
    logicalSessionId: optionalText(input.logicalSessionId),
    providerId: requiredText(input.providerId, "providerId"),
    providerSessionId: requiredText(input.providerSessionId, "providerSessionId"),
    bindingId: requiredText(input.bindingId, "bindingId"),
    routingVersion: Number(input.routingVersion),
    turnId: requiredText(input.turnId, "turnId"),
    startedAt: optionalText(input.startedAt)
  };
  if (!Number.isSafeInteger(entry.routingVersion) || entry.routingVersion < 1) {
    throw new TypeError("routingVersion must be a positive integer.");
  }
  return entry;
}

function publicEntry(entry) {
  return {
    sessionId: entry.sessionId,
    logicalSessionId: entry.logicalSessionId,
    providerId: entry.providerId,
    providerSessionId: entry.providerSessionId,
    bindingId: entry.bindingId,
    routingVersion: entry.routingVersion,
    turnId: entry.turnId,
    startedAt: entry.startedAt,
    ...(entry.timeoutKind ? { timeoutKind: entry.timeoutKind } : {}),
    ...(entry.lastActivityAt ? { lastActivityAt: entry.lastActivityAt } : {})
  };
}

function turnKey(entry) {
  return `${entry.bindingId}:${entry.turnId}`;
}

function requiredText(value, field) {
  const result = optionalText(value);
  if (!result) throw new TypeError(`${field} is required.`);
  return result;
}

function optionalText(value) {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function positiveDelay(value, fallback) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new TypeError("Watchdog delays must be positive numbers.");
  return result;
}
