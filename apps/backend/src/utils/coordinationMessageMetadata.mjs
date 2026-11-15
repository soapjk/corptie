// Older product-event projections stored the whole item around its metadata.
// Follow only that explicit envelope; prose and Provider payloads are not types.
export function coordinationMessageMetadata(rawMetadataJSON) {
  let encoded = rawMetadataJSON;
  while (typeof encoded === "string") {
    let value;
    try { value = JSON.parse(encoded); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.coordinationEvent != null || value.executionMode === "shadow_report"
      || typeof value.progressBatchId === "string" || typeof value.replyToMessageId === "string") return value;
    encoded = value.rawMetadataJSON;
  }
  return null;
}
