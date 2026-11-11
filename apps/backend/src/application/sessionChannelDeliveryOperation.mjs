import { formatTrustedChannelMessage, formatTrustedChannelBatch } from "../collaboration/trustedCollaborationEvent.mjs";

export function createSessionChannelDeliveryOperation({
  store, sessionChannelService, resumeSession, sendMessage, now, channelMailbox
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
      deliveryId: metadata.deliveryId,
      batchId: metadata.batchId,
      messageIds: metadata.messageIds
    }, { fromAgentWorkQueue: true });
    if (response.queued) {
      if (response.message?.id) store.removeItem(sessionId, response.message.id);
      const error = new Error("Target Session became busy before collaboration delivery started.");
      error.code = "SESSION_BUSY";
      throw error;
    }
    return { turnId: response.result?.turnId ?? response.result?.turn?.id ?? null };
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
    if (channelMailbox) return dispatchBatch(deliveryId, route, state);
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

  async function dispatchBatch(deliveryId, route, state) {
    const work = store.getRunningAgentTaskForSession(route.providerSessionId);
    if (!work) throw new Error("Channel batch requires a claimed Session operation.");
    let batch;
    let submitted = false;
    try {
      batch = channelMailbox.prepareBatch(deliveryId, work.taskId);
      if (batch.status === "accepted") return sessionChannelService.getDelivery(deliveryId);
      if (batch.status !== "prepared") return { status: "failed",
        lastError: "Channel batch dispatch is uncertain; automatic replay is blocked.", batchId: batch.batch_id };
      if (state === "stopped") await resumeCollaborationSession(route.providerSessionId);
      const items = channelMailbox.getItems(batch.batch_id);
      for (const item of items) {
        const currentRoute = sessionChannelService.resolveDeliveryRoute(item.delivery.deliveryId);
        if (currentRoute.providerSessionId !== route.providerSessionId || currentRoute.routingVersion !== route.routingVersion) {
          const error = new Error("Channel route changed before batch dispatch.");
          error.code = "SESSION_BUSY";
          throw error;
        }
      }
      const batchText = channelMailbox.prepareMixedReports(batch,formatTrustedChannelBatch(items,batch.batch_id));
      channelMailbox.mark(batch.batch_id, "dispatching");
      submitted = true;
      const result = await startCollaborationTurn(route.providerSessionId,
        batchText, {
          deliveryId, batchId: batch.batch_id, messageId: items[0].message.messageId,
          channelId: items[0].channel.channelId, messageIds: items.map(item => item.message.messageId)
        });
      if (!result.turnId) throw new Error("Provider did not return a turn receipt; automatic replay is blocked.");
      channelMailbox.mark(batch.batch_id, "accepted", { turnId: result.turnId });
      return sessionChannelService.getDelivery(deliveryId);
    } catch (error) {
      if (batch && error.code === "SESSION_BUSY") {
        channelMailbox.mark(batch.batch_id, "prepared");
        return sessionChannelService.getDelivery(deliveryId);
      }
      if (batch) channelMailbox.mark(batch.batch_id, submitted ? "unknown" : "failed", { error: error.message });
      else sessionChannelService.updateDelivery(deliveryId, { status: "failed", incrementAttempt: true, lastError: error.message });
      // A potentially accepted Provider request must not return to the retry queue.
      return { status: "failed", lastError: error.message, batchId: batch?.batch_id ?? null };
    }
  }

  return {
    dispatchSessionChannelDelivery, inspectCollaborationSession,
    resumeCollaborationSession, startCollaborationTurn
  };
}
