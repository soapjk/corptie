import { createHash } from "node:crypto";

export function canonicalJson(value) {
  return serialize(value);
}

export function contentHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function hashWithout(value, field) {
  const copy = { ...value };
  delete copy[field];
  return contentHash(copy);
}

function serialize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw benchmarkError("BENCHMARK_CANONICAL_VALUE_INVALID", "Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort(asciiCompare).map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`).join(",")}}`;
  }
  throw benchmarkError("BENCHMARK_CANONICAL_VALUE_INVALID", "Canonical JSON rejects undefined, functions, and symbols.");
}

export function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertClosedObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", `${label} must be an object.`, label);
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", `${label} contains unknown field ${key}.`, label);
  }
}

export function requireFields(value, fields, stage) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field) || value[field] === undefined) {
      const code = `BENCHMARK_${String(stage).toUpperCase().replaceAll("-", "_")}_REQUIRED_FIELD_MISSING`;
      throw benchmarkError(code, `${stage} receipt is missing ${field}.`, stage);
    }
  }
}

export function benchmarkError(code, safeMessage, stage = null, options = {}) {
  const error = new Error(safeMessage);
  error.code = code;
  error.stage = stage;
  error.retryable = options.retryable === true;
  error.safeMessage = safeMessage;
  error.evidenceRefs = Array.isArray(options.evidenceRefs) ? options.evidenceRefs : [];
  error.statusCode = options.statusCode ?? 400;
  return error;
}

export function safeBenchmarkError(error) {
  return {
    code: error?.code ?? "BENCHMARK_INTERNAL_ERROR",
    stage: error?.stage ?? null,
    retryable: error?.retryable === true,
    safeMessage: error?.safeMessage ?? "Benchmark operation failed.",
    evidenceRefs: Array.isArray(error?.evidenceRefs) ? error.evidenceRefs : []
  };
}
