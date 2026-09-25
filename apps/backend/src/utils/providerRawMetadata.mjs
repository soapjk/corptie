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

export function providerSafeDiagnosticPayload(value) {
  return sanitizeValue(value ?? {}, "payload", 0, new WeakSet());
}

export function providerSafeToolText(value, { pretty = false } = {}) {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (value.length <= MAX_STRING_LENGTH && /^[{[]/.test(trimmed)) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify(sanitizeValue(parsed, "payload", 0, new WeakSet()), null, pretty ? 2 : 0);
        }
      } catch { /* A partial or plain-text result still gets inline redaction. */ }
    }
    return sanitizeValue(value, "payload", 0, new WeakSet());
  }
  return JSON.stringify(sanitizeValue(value, "payload", 0, new WeakSet()), null, pretty ? 2 : 0);
}

function sanitizeValue(value, key, depth, seen) {
  if (SENSITIVE_KEY.test(String(key))) return "[REDACTED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH && /^[{[]/.test(value.trim())) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify(sanitizeValue(parsed, key, depth + 1, seen));
        }
      } catch { /* Preserve non-JSON text after inline redaction. */ }
    }
    const bounded = value.length <= MAX_STRING_LENGTH ? value
      : `${value.slice(0, MAX_STRING_LENGTH)}\n… [truncated ${value.length - MAX_STRING_LENGTH} characters]`;
    return redactInlineSecrets(bounded);
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

function redactInlineSecrets(value) {
  return value
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;&]+/gi, "authorization=[REDACTED]")
    .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[REDACTED]");
}
