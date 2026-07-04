export function nowIso() {
  return new Date().toISOString();
}

export function normalizeTimestamp(value) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  return null;
}

export function createdAtFrom(...sources) {
  for (const source of sources) {
    const timestamp = timestampFromSource(source);
    if (timestamp) {
      return timestamp;
    }
  }
  return null;
}

export function createdAtFromOrNow(...sources) {
  return createdAtFrom(...sources) ?? nowIso();
}

function timestampFromSource(source) {
  if (source == null) {
    return null;
  }
  const normalized = normalizeTimestamp(source);
  if (normalized) {
    return normalized;
  }
  if (typeof source !== "object") {
    return null;
  }
  return normalizeTimestamp(
    source.createdAt
    ?? source.created_at
    ?? source.timestamp
    ?? source.startedAt
    ?? source.started_at
    ?? source.time
    ?? source.internal_chat_message_metadata_passthrough?.createdAt
    ?? source.internal_chat_message_metadata_passthrough?.created_at
    ?? source.internal_chat_message_metadata_passthrough?.timestamp
  );
}
