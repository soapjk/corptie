import { types } from "node:util";
import { redactInlineSecrets } from "./providerRawMetadata.mjs";

const FIELDS = ["name", "message", "stack", "code", "errno", "syscall", "status", "statusCode", "exit", "exitCode", "exit_code", "signal"];
const CONTEXT = ["sessionId", "taskId", "workId", "serverId", "providerId", "requestId", "operation", "stage", "method", "status", "toolName", "logicalSessionId", "providerSessionId", "bindingId", "turnId", "messageId", "jobId", "transitionId", "attemptId", "operationId", "repositoryId", "worktreeId", "attempt"];

// Node 26 exposes standard Error stacks through a shared native accessor.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const initialStackFormatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")?.value;
function nativeStack(value, descriptor) {
  if (!nativeStackGetter || descriptor.get !== nativeStackGetter || !types.isNativeError(value)) return "[unavailable: accessor]";
  if (Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")?.value !== initialStackFormatter) return "[unavailable: stack formatter]";
  // Native stack formatting reads name/message. Do not let it invoke user getters.
  for (const key of ["name", "message"]) {
    for (let object = value, depth = 0; object && depth < 6; object = Object.getPrototypeOf(object), depth++) {
      const field = Object.getOwnPropertyDescriptor(object, key);
      if (field) {
        if (!("value" in field) || (field.value != null && !["string", "number", "boolean"].includes(typeof field.value))) return "[unavailable: stack metadata]";
        break;
      }
    }
  }
  return nativeStackGetter.call(value);
}

// Descriptor reads avoid running arbitrary getters supplied by an upstream error.
function read(value, key) {
  try {
    for (let object = value, depth = 0; object && depth < 6; object = Object.getPrototypeOf(object), depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : key === "stack" ? nativeStack(value, descriptor) : "[unavailable: accessor]";
    }
  } catch { return "[unavailable: property]"; }
}

function text(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return undefined;
  // Redact before bounding, so a truncation cannot expose a partial credential.
  const safe = redactInlineSecrets(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, raw => {
      try { const url = new URL(raw); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "[REDACTED URL]"; }
    })
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[REDACTED authorization]")
    .replace(/\b(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\/(?:Users|home)\/[^/\s:]+/g, "~")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  return safe.length > 4000 ? `${safe.slice(0, 4000)}[truncated: text]` : safe;
}

export function logError(scope, error, context = {}) {
  try {
    const seen = new WeakSet();
    let count = 0;
    const chain = (value, depth = 0) => {
      if (depth >= 6 || ++count > 32) return "[truncated: error chain]";
      if (!value || typeof value !== "object") return { message: text(value) ?? "[unavailable: non-error]" };
      if (seen.has(value)) return "[circular error]";
      seen.add(value);
      const result = {};
      for (const key of FIELDS) {
        const safe = text(read(value, key));
        if (safe !== undefined) result[key] = safe;
      }
      const cause = read(value, "cause");
      if (cause !== undefined) result.cause = chain(cause, depth + 1);
      const errors = read(value, "errors");
      if (Array.isArray(errors)) {
        result.errors = [];
        const total = read(errors, "length");
        const length = typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? Math.min(total, 8) : 0;
        for (let index = 0; index < length; index++) result.errors.push(chain(read(errors, String(index)), depth + 1));
        if (typeof total !== "number") result.errors.push("[unavailable: aggregate length]");
        if (typeof total === "number" && total > 8) result.errors.push("[truncated: aggregate errors]");
      }
      return result;
    };
    const safeContext = {};
    for (const key of CONTEXT) {
      const safe = text(read(context, key));
      if (safe !== undefined) safeContext[key] = safe;
    }
    const safeScope = typeof scope === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(scope) ? scope : "error";
    console.error(`[${safeScope}]`, JSON.stringify({ timestamp: new Date().toISOString(), error: chain(error), context: safeContext }));
  } catch { /* Logging must never change the failure it observes, including sink failures. */ }
}
