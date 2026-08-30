const encoder = new TextEncoder();

export const ARTIFACT_CONTEXT_POLICY_REVISION = "artifact-context-budget-v2";

export const ARTIFACT_CONTEXT_DEFAULT_LIMITS = Object.freeze({
  objectiveChatSnapshot: Object.freeze({ maxEstimatedTokens: 8_192, maxUtf8Bytes: 32_768 }),
  objectiveArtifactIndex: Object.freeze({ maxEstimatedTokens: 2_048, maxUtf8Bytes: 8_192, maxItems: 80 }),
  workerArtifactIndex: Object.freeze({ maxEstimatedTokens: 4_096, maxUtf8Bytes: 16_384, maxItems: 80 }),
  artifactSummary: Object.freeze({ maxEstimatedTokens: 256, maxUtf8Bytes: 1_024 })
});

export class ArtifactContextBudgetPolicy {
  constructor(options = {}) {
    this.estimatorRevision = options.estimatorRevision ?? "unicode-scalars-or-utf8-div3-v1";
    this.tokenEstimator = options.tokenEstimator ?? estimateArtifactTokens;
  }

  measureAndPack({ section, candidates = [], limits, stableOrder = null } = {}) {
    if (!section || !limits || !Number.isSafeInteger(limits.maxEstimatedTokens)
      || !Number.isSafeInteger(limits.maxUtf8Bytes)
      || limits.maxEstimatedTokens < 0 || limits.maxUtf8Bytes < 0) {
      throw budgetError("ARTIFACT_CONTEXT_BUDGET_INVALID", "Artifact context limits must be non-negative integers.");
    }
    const ordered = [...candidates];
    if (stableOrder) ordered.sort(stableOrder);
    const maxItems = Number.isSafeInteger(limits.maxItems) ? Math.max(0, limits.maxItems) : Number.MAX_SAFE_INTEGER;
    const items = [];
    let estimatedTokens = 0;
    let serializedUtf8Bytes = 0;
    const omissionReasons = {};
    let stoppedReason = null;
    for (const candidate of ordered) {
      if (stoppedReason) {
        omissionReasons[stoppedReason] = (omissionReasons[stoppedReason] ?? 0) + 1;
        continue;
      }
      if (items.length >= maxItems) {
        stoppedReason = "item_limit";
        omissionReasons[stoppedReason] = 1;
        continue;
      }
      const serialized = JSON.stringify(candidate);
      if (serialized == null) throw budgetError("ARTIFACT_CONTEXT_BUDGET_INVALID", `Section ${section} contains a non-serializable item.`);
      const bytes = encoder.encode(serialized).byteLength;
      const tokens = this.tokenEstimator(serialized, bytes);
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw budgetError("ARTIFACT_CONTEXT_BUDGET_INVALID", "Artifact token estimator returned an invalid value.");
      }
      if (estimatedTokens + tokens > limits.maxEstimatedTokens) stoppedReason = "token_limit";
      else if (serializedUtf8Bytes + bytes > limits.maxUtf8Bytes) stoppedReason = "byte_limit";
      if (stoppedReason) {
        omissionReasons[stoppedReason] = 1;
        continue;
      }
      items.push(candidate);
      estimatedTokens += tokens;
      serializedUtf8Bytes += bytes;
    }
    return Object.freeze({
      items: Object.freeze(items),
      usage: Object.freeze({ estimatedTokens, serializedUtf8Bytes, itemCount: items.length }),
      limits: Object.freeze({ ...limits }),
      omittedCount: ordered.length - items.length,
      omissionReasons: Object.freeze(omissionReasons),
      estimatorRevision: this.estimatorRevision
    });
  }
}

export function boundArtifactSummary(value, limits = ARTIFACT_CONTEXT_DEFAULT_LIMITS.artifactSummary) {
  const source = typeof value === "string" ? value : "";
  const summaryOriginalBytes = encoder.encode(source).byteLength;
  if (!source) return Object.freeze({ summary: "", summaryTruncated: false, summaryOriginalBytes: 0 });
  let summary = "";
  let bytes = 0;
  let scalars = 0;
  for (const scalar of source) {
    const scalarBytes = encoder.encode(scalar).byteLength;
    const nextBytes = bytes + scalarBytes;
    const nextScalars = scalars + 1;
    const nextTokens = Math.max(nextScalars, Math.ceil(nextBytes / 3));
    if (nextBytes > limits.maxUtf8Bytes || nextTokens > limits.maxEstimatedTokens) break;
    summary += scalar;
    bytes = nextBytes;
    scalars = nextScalars;
  }
  return Object.freeze({
    summary,
    summaryTruncated: summary !== source,
    summaryOriginalBytes
  });
}

export function estimateArtifactTokens(serialized, knownBytes = null) {
  const value = String(serialized ?? "");
  const bytes = knownBytes ?? encoder.encode(value).byteLength;
  return Math.max(Array.from(value).length, Math.ceil(bytes / 3));
}

export function serializedUtf8Bytes(value) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function budgetError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 500;
  return error;
}
