// Publishes committed outbox records; persistence and Provider ingestion remain
// separate. Listener failures and broken SSE clients cannot abort other listeners.
export function createProviderEventPublisher({
  store, eventLog, sseClients, now, resolveProviderEventBinding,
  scheduleTimelineChangePublish, scheduleStateSyncPublish, scheduleAgentWorkDrain,
  onCommittedMessageDelivery, publishDeviceTimeline
}) {
  const sessionEventListeners = new Set();

  function publishProviderEventOutbox(rows = []) {
    for (const row of rows) {
      try {
        const envelope = JSON.parse(row.payload_json);
        if (row.topic === "timeline") {
          scheduleTimelineChangePublish(envelope);
        } else if (row.topic === "state") {
          scheduleStateSyncPublish();
        } else if (row.topic === "provider-commands") {
          if (row.event_type === "MessageDeliveryQueued") {
            onCommittedMessageDelivery(envelope);
          }
          scheduleAgentWorkDrain(envelope.sessionId);
        } else if (row.topic === "provider-events") {
          publishCommittedProviderWake(envelope?.event ?? null, row.created_at);
          notifySessionEventListeners(envelope?.sessionEvent ?? null);
        }
        store.markEventOutboxPublished(row.outbox_id, now());
      } catch (error) {
        console.warn(`[provider-outbox] publish deferred id=${row.outbox_id} error=${error.message}`);
      }
    }
  }

  function notifySessionEventListeners(sessionEvent) {
    if (!sessionEvent) return;
    for (const listener of sessionEventListeners) {
      try {
        listener(sessionEvent);
      } catch (error) {
        console.warn(`[session-events] listener failed type=${sessionEvent.type ?? "unknown"} session=${sessionEvent.sessionId ?? "unknown"}: ${error.message}`);
      }
    }
  }

  function publishCommittedProviderWake(providerEvent, createdAt) {
    if (!providerEvent) return;
    const event = eventLog.append({
      type: "ProviderEventCommitted",
      payload: {
        sessionId: resolveProviderEventBinding(providerEvent)?.sessionId ?? null,
        providerId: providerEvent.providerId,
        bindingId: providerEvent.bindingId,
        turnId: providerEvent.turnId ?? null,
        itemId: providerEvent.itemId ?? null,
        eventType: providerEvent.type
      },
      createdAt: createdAt ?? providerEvent.receivedAt ?? now()
    });
    const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of sseClients) {
      try {
        response.write(frame);
      } catch (error) {
        console.warn(`[provider-outbox] client write failed event=${providerEvent.type}: ${error.message}`);
      }
    }
    if (providerEvent.type === "usage.updated") {
      const sessionId = resolveProviderEventBinding(providerEvent)?.sessionId ?? null;
      if (sessionId) publishDeviceTimeline(sessionId);
      const usage = sessionId ? store.getSessionUsageSnapshot(sessionId) : null;
      if (usage?.context) {
        const usageEvent = eventLog.append({
          type: "SessionUsageUpdated",
          payload: { sessionId, context: usage.context },
          createdAt: createdAt ?? providerEvent.receivedAt ?? now()
        });
        const usageFrame = `id: ${usageEvent.id}\nevent: ${usageEvent.type}\ndata: ${JSON.stringify(usageEvent)}\n\n`;
        for (const response of sseClients) {
          try { response.write(usageFrame); }
          catch (error) {
            console.warn(`[provider-outbox] client write failed event=usage.updated: ${error.message}`);
          }
        }
      }
    }
  }

  return {
    publishProviderEventOutbox, notifySessionEventListeners,
    addSessionEventListener(listener) {
      sessionEventListeners.add(listener);
      return () => sessionEventListeners.delete(listener);
    }
  };
}
