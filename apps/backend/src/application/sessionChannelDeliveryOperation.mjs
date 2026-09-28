import { formatTrustedChannelMessage } from "../collaboration/trustedCollaborationEvent.mjs";

export function createSessionChannelDeliveryOperation({
  store, sessionChannelService, resumeSession, sendMessage, now
}) {
  async function inspectCollaborationSession(sessionId) {
    const session = store.getSession(sessionId);
    if (!session) return "missing";
    if (store.listUnsettledSessionTurns(sessionId).length > 0) return "running";
    return ["failed", "cancelled"].includes(session.status) ? "stopped" : "idle";
  }

  async function resumeCollaborationSession(sessionId) {
    await resumeSession(sessionId, { source: "collaboration" });
  }

  async function startCollaborationTurn(sessionId, text, metadata = {}) {
    const response = await sendMessage(sessionId, text, {
      type: metadata.channelId ? "session_channel" : "collaboration",
      messageId: metadata.messageId,
      taskId: metadata.taskId,
      channelId: metadata.channelId,
      deliveryId: metadata.deliveryId
    }, { fromAgentWorkQueue: true });
    if (response.queued) {
      if (response.message?.id) store.removeItem(sessionId, response.message.id);
      const error = new Error("Target Session became busy before collaboration delivery started.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    return { turnId: response.result?.turn?.id ?? response.result?.turnId ?? null };
  }

  async function dispatchSessionChannelDelivery(deliveryId, resolvedRoute = null) {
    const envelope = sessionChannelService.getDeliveryEnvelope(deliveryId);
    if (!envelope) return null;
    const route = resolvedRoute ?? sessionChannelService.resolveDeliveryRoute(deliveryId);
    const state = await inspectCollaborationSession(route.providerSessionId);
    if (state === "running") {
      return sessionChannelService.updateDelivery(deliveryId, {
        status: "queued", nextAttemptAt: null, lastError: null
      });
    }
    if (state === "missing") {
      return sessionChannelService.updateDelivery(deliveryId, {
        status: "failed", incrementAttempt: true, nextAttemptAt: null,
        lastError: `Target Session ${route.sessionId} is unavailable.`
      });
    }
    if (!sessionChannelService.claimDelivery(deliveryId)) return sessionChannelService.getDelivery(deliveryId);
    try {
      if (state === "stopped") await resumeCollaborationSession(route.providerSessionId);
      const result = await startCollaborationTurn(
        route.providerSessionId,
        formatTrustedChannelMessage(envelope),
        { deliveryId, messageId: envelope.message.messageId, channelId: envelope.channel.channelId }
      );
      return sessionChannelService.updateDelivery(deliveryId, {
        status: "delivered", deliveredAt: now(),
        targetTurnId: result?.turnId ?? null, nextAttemptAt: null, lastError: null
      });
    } catch (error) {
      if (error.code === "SESSION_BUSY") {
        return sessionChannelService.updateDelivery(deliveryId, {
          status: "queued", nextAttemptAt: null, lastError: null
        });
      }
      return sessionChannelService.updateDelivery(deliveryId, {
        status: "failed", incrementAttempt: true, nextAttemptAt: null, lastError: error.message
      });
    }
  }

  return {
    dispatchSessionChannelDelivery, inspectCollaborationSession,
    resumeCollaborationSession, startCollaborationTurn
  };
}
