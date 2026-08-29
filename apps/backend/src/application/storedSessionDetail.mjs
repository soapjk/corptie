/// Builds the provider-neutral, read-only detail from Corptie's materialized
/// Session projection. Event logs are audit input, never a read-time fallback.
export function storedSessionDetail({ summary, storedDetail }) {
  const snapshotItems = Array.isArray(storedDetail?.items) ? storedDetail.items : [];
  const provider = summary?.external?.provider ?? summary?.provider ?? storedDetail?.source ?? null;
  return {
    ...summary,
    ...storedDetail,
    id: summary?.id ?? storedDetail?.id,
    title: summary?.title ?? storedDetail?.title ?? "Session",
    source: provider,
    connectionStatus: "disconnected",
    canSend: false,
    sendUnavailableReason: providerUnavailableReason(summary),
    capabilities: readOnlyCapabilities(storedDetail?.capabilities ?? summary?.capabilities),
    items: snapshotItems
  };
}

function providerUnavailableReason(summary) {
  if (summary?.status === "failed") {
    const failure = summary.sendUnavailableReason ?? summary.summary;
    if (typeof failure === "string" && failure.trim()) return failure.trim();
  }
  return "The Provider is offline. Stored conversation history is available read-only.";
}

export function persistableSessionItems(detail) {
  if (!Array.isArray(detail?.items)) return [];
  return detail.items.filter((item) =>
    item
    && typeof item.id === "string"
    && item.id.length > 0
    && typeof item.text === "string"
    && item.text.length > 0
  );
}

function readOnlyCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? {};
  return {
    ...value,
    canSend: false,
    canInterrupt: false,
    canApprove: false,
    canSwitchModel: false,
    canSwitchReasoning: false
  };
}
