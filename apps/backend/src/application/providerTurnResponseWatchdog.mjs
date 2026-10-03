const DEFAULT_WARNING_AFTER_MS = 20_000;
const DEFAULT_TIMEOUT_AFTER_MS = 120_000;
const RELIABLE_HEARTBEAT = "reliable";

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

/**
 * Provider-neutral response-activity watchdog.
 *
 * The warning and first-activity timeout cover a silent start. A rolling hard
 * timeout is armed only when the Provider explicitly guarantees reliable
 * heartbeats. Other Providers receive a one-shot stalled-stream warning and
 * remain interruptible; elapsed wall-clock time alone is never proof that an
 * otherwise active interactive Turn has failed.
 */
export class ProviderTurnResponseWatchdog {
  constructor(options = {}) {
    this.warningAfterMs = positiveDelay(options.warningAfterMs, DEFAULT_WARNING_AFTER_MS);
    this.timeoutAfterMs = positiveDelay(options.timeoutAfterMs, DEFAULT_TIMEOUT_AFTER_MS);
    if (this.timeoutAfterMs <= this.warningAfterMs) {
      throw new TypeError("Provider response timeout must be greater than its warning delay.");
    }
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.onDelayed = options.onDelayed ?? (() => {});
    this.onTimeout = options.onTimeout ?? (() => {});
    this.resolveTurnLiveness = options.resolveTurnLiveness ?? (() => null);
    this.pending = new Map();
    this.resolved = new Set();
    this.maximumResolvedKeys = options.maximumResolvedKeys ?? 4_096;
  }

  watch(input = {}) {
    const entry = normalizedEntry(input);
    const key = turnKey(entry);
    if (this.resolved.has(key) || this.pending.has(key)) return false;
    const turnLiveness = normalizedTurnLiveness(this.resolveTurnLiveness(entry.providerId));

    const warningTimer = this.schedule(() => {
      const current = this.pending.get(key);
      if (!current) return;
      current.warningTimer = null;
      this.#invoke(this.onDelayed, current);
    }, this.warningAfterMs);
    const timeoutTimer = this.#scheduleTimeout(key, this.timeoutAfterMs, "first_activity");
    warningTimer?.unref?.();
    timeoutTimer?.unref?.();
    this.pending.set(key, {
      ...entry,
      turnLiveness,
      warningTimer,
      stallWarningTimer: null,
      timeoutTimer,
      hasActivity: false,
      lastActivityAt: null
    });
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
      return current ? this.#recordRetryFailure(key, current, event) : false;
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) return this.resolve(entry);
    if (SUBSTANTIVE_EVENT_TYPES.has(event.type)) {
      const current = this.pending.get(key);
      return current ? this.#recordSubstantiveActivity(key, current, event) : false;
    }
    if (event.type === "provider.activity") {
      const current = this.pending.get(key);
      return current ? this.#recordHeartbeat(key, current, event) : false;
    }
    return false;
  }

  resolve(input = {}) {
    const entry = normalizedEntry(input);
    const key = turnKey(entry);
    const current = this.pending.get(key);
    if (current) {
      if (current.warningTimer) this.cancel(current.warningTimer);
      if (current.stallWarningTimer) this.cancel(current.stallWarningTimer);
      if (current.timeoutTimer) this.cancel(current.timeoutTimer);
      this.pending.delete(key);
    }
    this.#rememberResolved(key);
    return Boolean(current);
  }

  close() {
    for (const current of this.pending.values()) {
      if (current.warningTimer) this.cancel(current.warningTimer);
      if (current.stallWarningTimer) this.cancel(current.stallWarningTimer);
      if (current.timeoutTimer) this.cancel(current.timeoutTimer);
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

  #invoke(callback, entry, additions = {}) {
    queueMicrotask(() => Promise.resolve(callback({ ...publicEntry(entry), ...additions })).catch((error) => {
      console.error(`[provider-response-watchdog] callback failed: ${error?.message ?? error}`);
    }));
  }

  #recordSubstantiveActivity(key, current, event) {
    if (current.warningTimer) {
      this.cancel(current.warningTimer);
      current.warningTimer = null;
    }
    if (current.timeoutTimer) this.cancel(current.timeoutTimer);
    if (current.stallWarningTimer) {
      this.cancel(current.stallWarningTimer);
      current.stallWarningTimer = null;
    }
    current.hasActivity = true;
    current.lastActivityAt = event.occurredAt ?? event.receivedAt ?? new Date().toISOString();
    current.lastFailureAt = null;
    current.lastProviderError = null;
    if (current.turnLiveness.heartbeat === RELIABLE_HEARTBEAT) {
      current.timeoutTimer = this.#scheduleTimeout(key, this.timeoutAfterMs, "inactivity");
      current.timeoutTimer?.unref?.();
    } else {
      current.timeoutTimer = null;
      current.stallWarningTimer = this.schedule(() => {
        const latest = this.pending.get(key);
        if (!latest) return;
        latest.stallWarningTimer = null;
        this.#invoke(this.onDelayed, latest, { warningKind: "stream_idle" });
      }, this.timeoutAfterMs);
      current.stallWarningTimer?.unref?.();
    }
    return true;
  }

  #recordHeartbeat(key, current, event) {
    current.lastProviderSignalAt = event.occurredAt ?? event.receivedAt ?? new Date().toISOString();
    if (!current.hasActivity
      || current.lastFailureAt
      || current.turnLiveness.heartbeat !== RELIABLE_HEARTBEAT) return true;
    if (current.timeoutTimer) this.cancel(current.timeoutTimer);
    current.timeoutTimer = this.#scheduleTimeout(key, this.timeoutAfterMs, "inactivity");
    current.timeoutTimer?.unref?.();
    return true;
  }

  // A Provider retry is evidence that the model request is not healthy. It
  // must never be treated as a heartbeat: doing so lets SDK-local retries keep
  // a Turn looking active while the model network is unavailable. Keep the
  // first retry deadline stable so a retry loop cannot extend it forever.
  #recordRetryFailure(key, current, event) {
    if (current.warningTimer) {
      this.cancel(current.warningTimer);
      current.warningTimer = null;
    }
    if (current.stallWarningTimer) {
      this.cancel(current.stallWarningTimer);
      current.stallWarningTimer = null;
    }
    current.lastProviderError = normalizedProviderError(event.payload?.error);
    if (!current.lastFailureAt) {
      current.lastFailureAt = event.occurredAt ?? event.receivedAt ?? new Date().toISOString();
      if (current.timeoutTimer) this.cancel(current.timeoutTimer);
      current.timeoutTimer = this.#scheduleTimeout(key, this.timeoutAfterMs, "provider_retry");
      current.timeoutTimer?.unref?.();
    }
    return true;
  }

  #scheduleTimeout(key, delay, timeoutKind) {
    return this.schedule(() => {
      const current = this.pending.get(key);
      if (!current) return;
      this.pending.delete(key);
      if (current.warningTimer) this.cancel(current.warningTimer);
      if (current.stallWarningTimer) this.cancel(current.stallWarningTimer);
      if (current.timeoutTimer) this.cancel(current.timeoutTimer);
      current.warningTimer = null;
      current.stallWarningTimer = null;
      current.timeoutTimer = null;
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
    ...(entry.lastActivityAt ? { lastActivityAt: entry.lastActivityAt } : {}),
    ...(entry.lastProviderSignalAt ? { lastProviderSignalAt: entry.lastProviderSignalAt } : {}),
    ...(entry.lastFailureAt ? { lastFailureAt: entry.lastFailureAt } : {}),
    ...(entry.lastProviderError ? { lastProviderError: entry.lastProviderError } : {})
  };
}

function normalizedProviderError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = optionalText(value.code) ?? "PROVIDER_REQUEST_RETRY";
  const message = optionalText(value.message) ?? "模型请求失败，正在重试。";
  return { code, message, retryable: value.retryable !== false };
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

function normalizedTurnLiveness(input) {
  const heartbeat = input?.heartbeat;
  return {
    heartbeat: ["reliable", "best_effort", "unavailable"].includes(heartbeat)
      ? heartbeat
      : "unavailable",
    supportsStatusProbe: input?.supportsStatusProbe === true
  };
}
