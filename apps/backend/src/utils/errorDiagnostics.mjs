import { types } from "node:util";
import { redactInlineSecrets } from "./providerRawMetadata.mjs";

const FIELDS = ["name", "message", "stack", "code", "errno", "syscall", "status", "statusCode", "exit", "exitCode", "exit_code", "signal"];
const CONTEXT = ["sessionId", "taskId", "workId", "serverId", "providerId", "requestId", "operation", "stage", "method", "status", "toolName", "logicalSessionId", "providerSessionId", "bindingId", "turnId", "messageId", "jobId", "transitionId", "attemptId", "operationId", "repositoryId", "worktreeId", "attempt"];
const RETRY_SCOPES = new Set(["collaboration-http.events", "catalog-mcp.revision"]);
const retryLogs = new Map();

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

function text(value, secretValues = []) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return undefined;
  // Redact before bounding, so a truncation cannot expose a partial credential.
  let redacted = value;
  for (const secret of secretValues) redacted = redacted.replaceAll(secret, "[REDACTED]");
  redacted = redacted.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[REDACTED]");
  const safe = redactInlineSecrets(redacted)
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
    let suppressed = 0;
    if (RETRY_SCOPES.has(scope)) {
      // Only repetitive background observers; never suppress independent user commands.
      const cause = read(error, "cause");
      const message = read(error, "message");
      const httpStatus = typeof message === "string" ? message.match(/\bHTTP\s+(\d{3})\b/)?.[1] : undefined;
      const key = [scope, read(error, "name"), read(error, "code"), read(cause, "code"), httpStatus]
        .map(value => typeof value === "string" || typeof value === "number" ? String(value).slice(0, 200) : "").join(":");
      const now = Date.now();
      const previous = retryLogs.get(key);
      if (previous && now >= previous.at && now - previous.at < 30_000) { previous.suppressed++; return; }
      suppressed = previous?.suppressed ?? 0;
      if (retryLogs.size >= 128) retryLogs.delete(retryLogs.keys().next().value);
      retryLogs.set(key, { at: now, suppressed: 0 });
    }
    // Use only secrets already supplied by the caller; never read configuration.
    const secretValues = [];
    const suppliedSecrets = read(context, "secretValues");
    if (Array.isArray(suppliedSecrets)) {
      const length = read(suppliedSecrets, "length");
      for (let index = 0; index < Math.min(Number.isSafeInteger(length) ? length : 0, 32); index++) {
        const secret = read(suppliedSecrets, String(index));
        if (typeof secret === "string" && secret) secretValues.push(secret);
      }
    }
    const seen = new WeakSet();
    let count = 0;
    const chain = (value, depth = 0) => {
      if (depth >= 6 || ++count > 32) return "[truncated: error chain]";
      if (!value || typeof value !== "object") return { message: text(value, secretValues) ?? "[unavailable: non-error]" };
      if (seen.has(value)) return "[circular error]";
      seen.add(value);
      const result = {};
      const syntax = read(value, "name") === "SyntaxError";
      for (const key of FIELDS) {
        // Parser messages/stacks can quote arbitrary payload bytes. Log the callsite instead.
        const raw = syntax && key === "message" ? "Syntax parsing failed; payload omitted."
          : syntax && key === "stack" ? read(new Error("Syntax parsing failed; payload omitted."), "stack")
          : read(value, key);
        const safe = text(raw, secretValues);
        if (safe !== undefined) result[key] = safe;
      }
      const cause = read(value, "cause");
      if (cause !== undefined) result.cause = chain(cause, depth + 1);
      const errors = read(value, "errors");
      if (Array.isArray(errors)) {
        result.errors = [];
        const total = read(errors, "length");
        const length = Math.min(Number.isSafeInteger(total) ? total : 0, 8);
        for (let index = 0; index < length; index++) result.errors.push(chain(read(errors, String(index)), depth + 1));
        if (total > 8) result.errors.push("[truncated: aggregate errors]");
      }
      return result;
    };
    const safeContext = {};
    for (const key of CONTEXT) {
      const safe = text(read(context, key), secretValues);
      if (safe !== undefined) safeContext[key] = safe;
    }
    const safeScope = typeof scope === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(scope) ? scope : "error";
    console.error(`[${safeScope}]`, JSON.stringify({ timestamp: new Date().toISOString(), error: chain(error), context: safeContext,
      ...(suppressed ? { repeatedFailures: suppressed } : {}) }));
  } catch { /* Logging must never change the failure it observes, including sink failures. */ }
}
