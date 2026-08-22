/// Builds the provider-neutral, read-only detail shown when a Provider cannot
/// currently be reached. Persisted item snapshots are preferred because they
/// preserve the complete normalized timeline; the event projection supports
/// databases created before detail snapshots were mirrored locally.
export function storedSessionDetail({ summary, storedDetail, eventItems = [] }) {
  const snapshotItems = Array.isArray(storedDetail?.items) ? storedDetail.items : [];
  const items = snapshotItems.length > 0 ? snapshotItems : eventItems;
  const provider = summary?.external?.provider ?? summary?.provider ?? storedDetail?.source ?? null;
  return {
    ...summary,
    ...storedDetail,
    id: summary?.id ?? storedDetail?.id,
    title: summary?.title ?? storedDetail?.title ?? "Session",
    source: provider,
    connectionStatus: "disconnected",
    canSend: false,
    sendUnavailableReason: "The Provider is offline. Stored conversation history is available read-only.",
    capabilities: readOnlyCapabilities(storedDetail?.capabilities ?? summary?.capabilities),
    items
  };
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
