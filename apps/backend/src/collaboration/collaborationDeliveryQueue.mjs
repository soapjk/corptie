import { formatTrustedChannelMessage, formatTrustedCollaborationEvent } from "./trustedCollaborationEvent.mjs";

// Bridges durable deliveries into the runtime queue; transport and retry ownership
// remain with their services, while execution stays on the shared Session path.
export function createCollaborationDeliveryQueue({
  store, sessionChannelService, collaborationCore, collaborationDispatcher,
  collaborationDeliveryRouteResolver, registerRuntimeQueuedWork,
  moveRuntimeQueuedWork, scheduleAgentWorkDrain, emitEvent
}) {
  async function syncSessionChannelDeliveriesIntoAgentWorkQueue() {
    const deliveries = [
      ...sessionChannelService.listPendingDeliveries(100, collaborationDispatcher.maxAttempts),
      ...sessionChannelService.listQueuedDeliveries(100)
    ];
    for (const delivery of deliveries) {
      const envelope = sessionChannelService.getDeliveryEnvelope(delivery.deliveryId);
      if (!envelope) {
        sessionChannelService.updateDelivery(delivery.deliveryId, {
          status: "failed", incrementAttempt: true, nextAttemptAt: null,
          lastError: "Channel delivery envelope is unavailable."
        });
        continue;
      }
      let route;
      try {
        route = sessionChannelService.resolveDeliveryRoute(delivery.deliveryId);
      } catch (error) {
        sessionChannelService.updateDelivery(delivery.deliveryId, {
          status: "failed", incrementAttempt: true, nextAttemptAt: null, lastError: error.message
        });
        continue;
      }
      const existingWork = store.getAgentTaskForDelivery(delivery.deliveryId);
      if (existingWork) {
        if (["failed", "cancelled"].includes(existingWork.status)) {
          store.updateAgentTask(existingWork.taskId, {
            status: "queued", sessionId: route.providerSessionId, startedAt: null,
            completedAt: null, targetTurnId: null, lastError: null
          });
          registerRuntimeQueuedWork(route.providerSessionId, existingWork.taskId);
          scheduleAgentWorkDrain(route.providerSessionId, null, existingWork.taskId);
        }
        continue;
      }
      const recipientAgent = collaborationCore.getAgentForSession(route.providerSessionId);
      if (!recipientAgent) continue;
      const task = store.enqueueAgentTask({
        taskId: `delivery:${delivery.deliveryId}`,
        agentId: recipientAgent.agentId,
        sessionId: route.providerSessionId,
        kind: "collaboration",
        priority: 50,
        text: formatTrustedChannelMessage(envelope),
        source: {
          type: "session_channel",
          channelId: envelope.channel.channelId,
          deliveryId: delivery.deliveryId,
          messageId: envelope.message.messageId,
          senderSessionId: envelope.message.senderSessionId,
          recipientSessionId: envelope.message.recipientSessionId,
          messageKind: envelope.message.messageKind,
          presentationText: envelope.message.body,
          resourceContext: envelope.message.resourceContext
        },
        localVisibility: "status_only",
        channelDeliveryId: delivery.deliveryId,
        createdAt: delivery.createdAt
      });
      registerRuntimeQueuedWork(route.providerSessionId, task.taskId);
      sessionChannelService.updateDelivery(delivery.deliveryId, {
        status: "queued", nextAttemptAt: null, lastError: null
      });
      emitEvent("AgentWorkQueued", {
        sessionId: route.providerSessionId, task, queuePosition: null, source: task.source
      }, { sessionId: route.providerSessionId, source: task.source });
      scheduleAgentWorkDrain(route.providerSessionId, null, task.taskId);
    }
  }

  async function syncCollaborationDeliveriesIntoAgentWorkQueue() {
    const deliveries = [
      ...collaborationCore.listPendingDeliveries(100, collaborationDispatcher.maxAttempts),
      ...collaborationCore.listQueuedDeliveries(100)
    ];
    for (const delivery of deliveries) {
      let envelope = collaborationCore.getDeliveryEnvelope(delivery.deliveryId);
      if (!envelope) {
        console.warn(`[collaboration-routing] event=delivery_envelope_missing deliveryId=${delivery.deliveryId}`);
        const error = Object.assign(
          new Error(`Collaboration delivery ${delivery.deliveryId} has no recoverable envelope.`),
          { code: "COLLABORATION_ENVELOPE_MISSING" }
        );
        collaborationDispatcher.failRoute(delivery.deliveryId, error, {
          eventType: "delivery_envelope_missing"
        });
        continue;
      }
      let route;
      try {
        route = await resolveCollaborationDeliveryRoute(envelope, "agent_work_enqueue_preflight");
        envelope = collaborationCore.getDeliveryEnvelope(delivery.deliveryId) ?? envelope;
      } catch (error) {
        console.error(`[collaboration-routing] event=enqueue_route_failed taskId=${envelope.task.taskId} deliveryId=${delivery.deliveryId} code=${error.code ?? "RECIPIENT_ROUTE_FAILED"} error=${JSON.stringify(error.message)}`);
        collaborationDispatcher.failRoute(delivery.deliveryId, error, {
          envelope,
          eventType: "enqueue_route_failed"
        });
        continue;
      }
      const existingWork = store.getAgentTaskForDelivery(delivery.deliveryId);
      if (existingWork) {
        if (["queued", "failed", "cancelled"].includes(existingWork.status)
            && route.providerSessionId && existingWork.sessionId !== route.providerSessionId) {
          const source = { ...existingWork.source, recipientSessionId: route.sessionId };
          store.updateAgentTask(existingWork.taskId, {
            sessionId: route.providerSessionId,
            status: "queued",
            startedAt: null,
            completedAt: null,
            targetTurnId: null,
            lastError: null,
            source
          });
          moveRuntimeQueuedWork(existingWork.sessionId, route.providerSessionId, existingWork.taskId);
          console.info(`[collaboration-routing] event=queued_work_rerouted taskId=${envelope.task.taskId} deliveryId=${delivery.deliveryId} fromSessionId=${existingWork.sessionId} toSessionId=${route.providerSessionId}`);
          scheduleAgentWorkDrain(route.providerSessionId, null, existingWork.taskId);
          continue;
        }
        if (["failed", "cancelled"].includes(existingWork.status)) {
          store.updateAgentTask(existingWork.taskId, {
            status: "queued",
            startedAt: null,
            completedAt: null,
            targetTurnId: null,
            lastError: null
          });
          registerRuntimeQueuedWork(existingWork.sessionId, existingWork.taskId);
          scheduleAgentWorkDrain(existingWork.sessionId, null, existingWork.taskId);
        }
        continue;
      }
      const agent = collaborationCore.getAgent(delivery.recipientAgentId);
      const sessionId = route.providerSessionId;
      if (!envelope || !agent || !sessionId) continue;
      const task = store.enqueueAgentTask({
        taskId: `delivery:${delivery.deliveryId}`,
        agentId: agent.agentId,
        sessionId,
        kind: "collaboration",
        priority: 50,
        text: formatTrustedCollaborationEvent(envelope),
        source: {
          type: "collaboration",
          deliveryId: delivery.deliveryId,
          messageId: envelope.message.messageId,
          taskId: envelope.task.taskId,
          senderAgentId: envelope.message.senderAgentId,
          senderAgentName: envelope.message.senderAgentName,
          recipientAgentName: agent.name,
          initiatorSessionId: envelope.task.initiatorSessionId,
          recipientSessionId: envelope.task.recipientSessionId,
          sourceTaskId: envelope.task.sourceTaskId,
          targetTaskId: envelope.task.taskId,
          routeStatus: envelope.task.routeStatus,
          routingVersion: envelope.task.routingVersion,
          taskTitle: envelope.task.title,
          messageKind: envelope.message.messageType,
          presentationText: envelope.message.body
        },
        localVisibility: "status_only",
        deliveryId: delivery.deliveryId,
        createdAt: delivery.createdAt
      });
      registerRuntimeQueuedWork(sessionId, task.taskId);
      if (delivery.status !== "queued") {
        collaborationCore.updateDelivery(delivery.deliveryId, { status: "queued", nextAttemptAt: null, lastError: null });
        collaborationCore.recordDeliveryEvent(delivery.deliveryId, "delivery_queued", { sessionId, reason: "agent_work_queue" });
      }
      console.info(`[collaboration-routing] event=delivery_enqueued taskId=${envelope.task.taskId} deliveryId=${delivery.deliveryId} channelId=${route.channelId ?? "none"} routeMode=${route.mode ?? "task_route"} logicalSessionId=${route.sessionId} providerSessionId=${sessionId}`);
      emitEvent("AgentWorkQueued", { sessionId, task, queuePosition: null, source: task.source }, { sessionId, source: task.source });
      scheduleAgentWorkDrain(sessionId, null, task.taskId);
    }
  }

  async function resolveCollaborationDeliveryRoute(envelope, reason) {
    const route = await collaborationDeliveryRouteResolver.resolve(envelope, { reason });
    console.info(`[collaboration-routing] event=route_resolved taskId=${envelope.task.taskId} deliveryId=${envelope.delivery.deliveryId} channelId=${route.channelId ?? "none"} routeMode=${route.mode} logicalSessionId=${route.sessionId} providerSessionId=${route.providerSessionId}`);
    return route;
  }

  return {
    syncSessionChannelDeliveriesIntoAgentWorkQueue,
    syncCollaborationDeliveriesIntoAgentWorkQueue,
    resolveCollaborationDeliveryRoute
  };
}
