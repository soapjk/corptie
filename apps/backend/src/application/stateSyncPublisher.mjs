// Owns revision cursors and the coalescing timer for resident state streams.
// Getters keep startup/recovery service replacement visible without caching it.
export function createStateSyncPublisher({
  readService, readRevision, invalidateDevices, recordSessionDiagnostic,
  scheduleTimeout = setTimeout, cancelTimeout = clearTimeout,
  warn = (message) => console.warn(message)
}) {
  const stateSyncClients = new Map();
  let stateSyncPublishTimer = null;

  function writeStateSyncFrame(response, name, data) {
    response.write(`id: ${data.revision}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function publishStateChangesIfNeeded() {
    const stateSyncService = readService();
    if (!stateSyncService) return;
    try {
      const current = readRevision();
      const deliveryByRevision = new Map();
      for (const [response, deliveredRevision] of stateSyncClients) {
        if (deliveredRevision === current) continue;
        let delivery = deliveryByRevision.get(deliveredRevision);
        if (!delivery) {
          const changes = stateSyncService.changesAfter(deliveredRevision);
          delivery = changes.snapshotRequired
            ? { name: "state-snapshot", data: stateSyncService.snapshot() }
            : { name: "state-change-set", data: changes };
          deliveryByRevision.set(deliveredRevision, delivery);
        }
        writeStateSyncFrame(response, delivery.name, delivery.data);
        stateSyncClients.set(response, delivery.data.revision);
        for (const session of delivery.data?.upserts?.sessions ?? []) {
          recordSessionDiagnostic(session.id, "statePublished", {
            revision: delivery.data.revision,
            status: session.status
          });
        }
      }
    } catch (error) {
      // A hot mutation boundary can prevent a stable read for this pass. Keep
      // every client cursor unchanged and retry; never acknowledge a revision
      // with an inconsistent payload or crash the backend timer callback.
      warn(`[state-sync] publish deferred code=${error.code ?? "unknown"} error=${error.message}`);
      scheduleStateSyncPublish();
    }
  }

  function scheduleStateSyncPublish() {
    invalidateDevices();
    if (stateSyncClients.size === 0 || stateSyncPublishTimer) return;
    // Collapse a burst of Provider item/progress events into one revision-aware
    // delivery. This avoids rebuilding the control-plane projection once per
    // event while keeping terminal propagation effectively immediate.
    stateSyncPublishTimer = scheduleTimeout(() => {
      stateSyncPublishTimer = null;
      publishStateChangesIfNeeded();
    }, 20);
    stateSyncPublishTimer.unref?.();
  }

  function cancelPendingPublish() {
    if (stateSyncPublishTimer) {
      cancelTimeout(stateSyncPublishTimer);
      stateSyncPublishTimer = null;
    }
  }

  return {
    stateSyncClients, writeStateSyncFrame,
    publishStateChangesIfNeeded, scheduleStateSyncPublish, cancelPendingPublish
  };
}
