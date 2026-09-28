// Resolves user-confirmed collaboration operations before triggering delivery.
// Replayed channel approvals reuse the durable confirmation and only retry delivery.
export function createCollaborationConfirmationCommands({
  collaborationCore, sessionChannelService, sessionCollaborationService, emitEvent,
  syncCollaborationDeliveriesIntoAgentWorkQueue, syncSessionChannelDeliveriesIntoAgentWorkQueue
}) {
  async function resolveCollaborationConfirmation(confirmationId, approved, source = { type: "desktop" }) {
    const before = collaborationCore.getTaskConfirmation(confirmationId);
    const preparedTarget = approved
      ? await sessionCollaborationService.prepareTaskConfirmationTarget(before)
      : null;
    const confirmation = approved
      ? collaborationCore.confirmTaskConfirmation(confirmationId, preparedTarget)
      : collaborationCore.rejectTaskConfirmation(confirmationId);
    const sessionId = confirmation.sourceSessionId ?? before?.sourceSessionId ?? null;
    emitEvent("CollaborationConfirmationResolved", { sessionId, confirmation }, { sessionId, source });
    if (approved) {
      await syncCollaborationDeliveriesIntoAgentWorkQueue().catch((error) => {
        console.error(`[collaboration] confirmation delivery sync failed: ${error.message}`);
      });
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
      await syncSessionChannelDeliveriesIntoAgentWorkQueue().catch((error) => {
        console.error(`[session-channel] confirmation replay delivery sync failed request=${requestId}: ${error.message}`);
      });
      return before;
    }
    let confirmed;
    try {
      const target = await sessionCollaborationService.prepareChannelRequestTarget(before);
      confirmed = sessionChannelService.confirmRequest(requestId, target, source);
    } catch (error) {
      sessionChannelService.failRequest(requestId, error);
      throw error;
    }
    emitEvent("SessionChannelRequestResolved", {
      sessionId: confirmed.requestingSessionId, request: confirmed
    }, { sessionId: confirmed.requestingSessionId, source });
    await syncSessionChannelDeliveriesIntoAgentWorkQueue().catch((error) => {
      console.error(`[session-channel] confirmation delivery sync failed request=${requestId}: ${error.message}`);
    });
    return confirmed;
  }

  return { resolveCollaborationConfirmation, resolveSessionChannelRequest };
}
