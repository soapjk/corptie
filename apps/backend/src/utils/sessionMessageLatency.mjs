const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeSessionMessageLatencyTrace(input = {}, defaults = {}) {
  if (!input || typeof input !== "object") input = {};
  if (!defaults || typeof defaults !== "object") defaults = {};
  const traceId = validTraceId(input.traceId) ?? validTraceId(defaults.traceId);
  if (!traceId) return null;
  return {
    traceId,
    sessionId: optionalText(input.sessionId) ?? optionalText(defaults.sessionId),
    clientClickedAtMs: finiteTimestamp(input.clientClickedAtMs),
    clientRequestStartedAtMs: finiteTimestamp(input.clientRequestStartedAtMs),
    serverReceivedAtMs: finiteTimestamp(input.serverReceivedAtMs)
      ?? finiteTimestamp(defaults.serverReceivedAtMs)
  };
}

export function sessionMessageLatencyTraceFromHeaders(headers = {}, defaults = {}) {
  return normalizeSessionMessageLatencyTrace({
    traceId: headers["x-corptie-message-trace-id"],
    clientClickedAtMs: headers["x-corptie-message-clicked-at-ms"],
    clientRequestStartedAtMs: headers["x-corptie-message-request-started-at-ms"]
  }, defaults);
}

export function logSessionMessageLatency(trace, stage, details = {}, options = {}) {
  const normalized = normalizeSessionMessageLatencyTrace(trace);
  if (!normalized) return null;
  const atMs = finiteTimestamp(options.atMs) ?? Date.now();
  const payload = {
    traceId: normalized.traceId,
    sessionId: normalized.sessionId,
    stage,
    atMs,
    sinceClickMs: elapsed(atMs, normalized.clientClickedAtMs),
    sinceRequestMs: elapsed(atMs, normalized.clientRequestStartedAtMs),
    sinceServerReceiveMs: elapsed(atMs, normalized.serverReceivedAtMs),
    ...details
  };
  (options.logger ?? console.info)(`[session-message-latency] ${JSON.stringify(payload)}`);
  return payload;
}

function validTraceId(value) {
  const text = optionalText(value);
  return text && TRACE_ID_PATTERN.test(text) ? text : null;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function elapsed(end, start) {
  return start === null ? null : Math.round((end - start) * 10) / 10;
}
