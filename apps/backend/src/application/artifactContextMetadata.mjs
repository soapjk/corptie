const encoder = new TextEncoder();

export const ARTIFACT_CONTEXT_POLICY_REVISION = "artifact-metadata-v1";

export function boundArtifactSummary(value) {
  const summary = typeof value === "string" ? value : "";
  return Object.freeze({ summary, summaryTruncated: false, summaryOriginalBytes: encoder.encode(summary).byteLength });
}

export function estimateArtifactTokens(serialized, knownBytes = null) {
  const value = String(serialized ?? "");
  const bytes = knownBytes ?? encoder.encode(value).byteLength;
  return Math.max(Array.from(value).length, Math.ceil(bytes / 3));
}

export function serializedUtf8Bytes(value) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

