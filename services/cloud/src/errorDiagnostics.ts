import { types } from "node:util";

const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const stackFormatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")?.value;
const fields = ["name", "message", "stack", "code", "errno", "syscall", "status", "statusCode", "exitCode", "signal"];

function read(value: unknown, key: string): unknown {
  try {
    for (let object = value, depth = 0; object && typeof object === "object" && depth < 6; object = Object.getPrototypeOf(object) as unknown, depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) continue;
      if ("value" in descriptor) return descriptor.value as unknown;
      if (key === "stack" && nativeStackGetter && descriptor.get === nativeStackGetter && types.isNativeError(value)
        && Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")?.value === stackFormatter) {
        for (const field of ["name", "message"]) {
          const metadata = read(value, field);
          if (typeof metadata !== "string" && metadata !== undefined) return "[unavailable: stack metadata]";
          if (metadata === "[unavailable: accessor]") return metadata;
        }
        return nativeStackGetter.call(value) as unknown;
      }
      return "[unavailable: accessor]";
    }
  } catch { return "[unavailable: property]"; }
  return undefined;
}

function safe(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[REDACTED]")
    .replace(/(["']?\b[\w-]*(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie)[\w-]*\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[REDACTED authorization]")
    .replace(/\b(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, input => {
      try { const url = new URL(input); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "[REDACTED URL]"; }
    })
    .replace(/\/(?:Users|home)\/[^/\s:]+/g, "~");
  return text.length > 4000 ? text.slice(0, 4000) + "[truncated: text]" : text;
}

// Only an existing stderr sink is used. No new storage, schema or HTTP contract.
export function logCloudError(scope: string, error: unknown): void {
  try {
    const seen = new WeakSet<object>();
    let count = 0;
    const capture = (value: unknown, depth = 0): unknown => {
      if (depth >= 6 || ++count > 32) return "[truncated: error chain]";
      if (!value || typeof value !== "object") return { message: safe(value) ?? "[unavailable: non-error]" };
      if (seen.has(value)) return "[circular error]";
      seen.add(value);
      const result: Record<string, unknown> = {};
      const syntax = read(value, "name") === "SyntaxError";
      for (const field of fields) {
        const raw = syntax && field === "message" ? "Syntax parsing failed; payload omitted."
          : syntax && field === "stack" ? read(new Error("Syntax parsing failed; payload omitted."), "stack") : read(value, field);
        const text = safe(raw);
        if (text !== undefined) result[field] = text;
      }
      const cause = read(value, "cause");
      if (cause !== undefined) result.cause = capture(cause, depth + 1);
      const errors = read(value, "errors");
      if (Array.isArray(errors)) {
        const length = read(errors, "length");
        const total = typeof length === "number" && Number.isSafeInteger(length) ? length : 0;
        const children: unknown[] = [];
        for (let index = 0; index < Math.min(total, 8); index++) children.push(capture(read(errors, String(index)), depth + 1));
        if (total > 8) children.push("[truncated: aggregate errors]");
        result.errors = children;
      }
      return result;
    };
    const operation = /^[a-zA-Z0-9_.:-]{1,100}$/.test(scope) ? scope : "cloud.error";
    console.error(`[${operation}]`, JSON.stringify({ timestamp: new Date().toISOString(), error: capture(error) }));
  } catch { /* A failed diagnostic sink must not alter the original response. */ }
}
