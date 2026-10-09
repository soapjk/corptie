// Resolves user-confirmed collaboration operations before triggering delivery.
// Replayed channel approvals reuse the durable confirmation and only retry delivery.
export function createCollaborationConfirmationCommands({
  collaborationCore, sessionChannelService, sessionCollaborationService, emitEvent,
  syncCollaborationDeliveriesIntoAgentWorkQueue, syncSessionChannelDeliveriesIntoAgentWorkQueue
}) {
  // The database is the reliable outbox. Acknowledgement must not wait for a
  // Provider turn or a scan of other Sessions. Coalesce wakeups per queue.
  const scheduled = new Set();
  function scheduleDelivery(kind, sync) {
    if (scheduled.has(kind)) return;
    scheduled.add(kind);
    setImmediate(async () => {
      scheduled.delete(kind);
      try { await sync(); }
      catch (error) { console.error(`[collaboration] ${kind} delivery sync failed: ${error.message}`); }
    });
  }
  async function resolveCollaborationConfirmation(confirmationId, approved, source = { type: "desktop" }) {
    const before = collaborationCore.getTaskConfirmation(confirmationId);
    if (approved && before?.status === "confirmed") {
      scheduleDelivery("task", syncCollaborationDeliveriesIntoAgentWorkQueue);
      return before;
    }
    const preparedTarget = approved
      ? await sessionCollaborationService.prepareTaskConfirmationTarget(before)
      : null;
    const confirmation = approved
      ? collaborationCore.confirmTaskConfirmation(confirmationId, preparedTarget)
      : collaborationCore.rejectTaskConfirmation(confirmationId);
    const sessionId = confirmation.sourceSessionId ?? before?.sourceSessionId ?? null;
    emitEvent("CollaborationConfirmationResolved", { sessionId, confirmation }, { sessionId, source });
    if (approved) {
      scheduleDelivery("task", syncCollaborationDeliveriesIntoAgentWorkQueue);
    }
    return confirmation;
  }

  async function resolveSessionChannelRequest(requestId, approved, source = { type: "desktop" }) {
    const before = sessionChannelService.getRequest(requestId);
    if (!before) {
      const error = new Error(`Channel request ${requestId} was not found.`);
      error.code = "CHANNEL_REQUEST_NOT_FOUND";
      throw error;
    }
    if (!approved) {
      const rejected = sessionChannelService.rejectRequest(requestId, source);
      emitEvent("SessionChannelRequestResolved", {
        sessionId: rejected.requestingSessionId, request: rejected
      }, { sessionId: rejected.requestingSessionId, source });
      return rejected;
    }
    if (before.status === "confirmed") {
      scheduleDelivery("channel", syncSessionChannelDeliveriesIntoAgentWorkQueue);
      return before;
    }
    let confirmed;
    try {
      const target = await sessionCollaborationService.prepareChannelRequestTarget(before);
      confirmed = sessionChannelService.confirmRequest(requestId, target, source);
    } catch (error) {
      const failed = sessionChannelService.failRequest(requestId, error);
      if (failed) emitEvent("SessionChannelRequestResolved", {
        sessionId: failed.requestingSessionId, request: failed
      }, { sessionId: failed.requestingSessionId, source });
      throw error;
    }
    emitEvent("SessionChannelRequestResolved", {
      sessionId: confirmed.requestingSessionId, request: confirmed
    }, { sessionId: confirmed.requestingSessionId, source });
    scheduleDelivery("channel", syncSessionChannelDeliveriesIntoAgentWorkQueue);
    return confirmed;
  }

  return { resolveCollaborationConfirmation, resolveSessionChannelRequest };
}
