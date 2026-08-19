const SENSITIVE_KEY = /authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie/i;
const MAX_STRING_LENGTH = 8_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_DEPTH = 12;

export function providerRawMetadataJSON(provider, payload, options = {}) {
  const envelope = {
    provider: String(provider || "unknown"),
    source: String(options.source || "provider_item"),
    payload: sanitizeValue(payload, "payload", 0, new WeakSet())
  };
  return JSON.stringify(envelope, null, 2);
}

function sanitizeValue(value, key, depth, seen) {
  if (SENSITIVE_KEY.test(String(key))) return "[REDACTED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}\n… [truncated ${value.length - MAX_STRING_LENGTH} characters]`;
  }
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[truncated: maximum metadata depth reached]";
  if (seen.has(value)) return "[circular reference]";
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.slice(0, MAX_ARRAY_ITEMS).map((item, index) =>
      sanitizeValue(item, String(index), depth + 1, seen)
    );
    if (value.length > MAX_ARRAY_ITEMS) {
      sanitized.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} array items]`);
    }
    return sanitized;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    sanitizeValue(childValue, childKey, depth + 1, seen)
  ]));
}
