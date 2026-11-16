// Older product-event projections stored the whole item around its metadata.
// Follow only that explicit envelope; prose and Provider payloads are not types.
export function coordinationMessageMetadata(rawMetadataJSON) {
  let encoded = rawMetadataJSON;
  let legacy = null;
  while (typeof encoded === "string") {
    let value;
    try { value = JSON.parse(encoded); } catch { return legacy; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return legacy;
    if (value.coordinationEvent != null || value.executionMode === "shadow_report"
      || typeof value.replyToMessageId === "string") return value;
    if (typeof value.progressBatchId === "string") legacy ??= value;
    encoded = value.rawMetadataJSON;
  }
  return legacy;
}

export function coordinationEventForMessage(item, metadata = coordinationMessageMetadata(item.rawMetadataJSON)) {
  if (metadata?.coordinationEvent) return metadata.coordinationEvent;
  const batchId = metadata?.progressBatchId ?? null;
  if (metadata?.executionMode === "shadow_report" || item.id?.startsWith("shadow-report:")
    || item.id?.startsWith("coordination-summary:") && batchId) return { kind: "summary", batchId };
  return typeof batchId === "string" ? { kind: "delivery", batchId } : null;
}

export function coordinationSummaryBody(text) {
  return String(text ?? "").replace(/^\s*\*\*后台汇总\*\*\s*\n\s*\n/u, "");
}
