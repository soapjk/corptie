import { collaborationMessagePresentationRoute } from "./collaborationPresentationRoute.mjs";
import { collaborationWorkPresentation } from "./collaborationWorkPresentation.mjs";
import { collaborationEnvelopeFailure } from "../utils/sessionEventPresentation.mjs";
import { userMessageStatusForAgentWork } from "../utils/agentWorkQueue.mjs";
import { userMessageDeletionEligibility } from "../application/userMessageDeletion.mjs";

// Read-only presentation: event publishing and delivery execution stay with their owners.
export function createCollaborationTimelinePresentation({ store, collaborationCore, sessionChannelService }) {
  function agentWorkTimelineItem(task, sessionId, queuePosition = null) {
    if (!task?.taskId || task.source?.deleted === true) return null;
    const presentation = collaborationPresentationForTask(task, sessionId);
    const userMessageStatus = userMessageStatusForAgentWork(task.status);
    const canonicalId = task.kind === "user"
      ? (task.source?.messageId ?? task.taskId)
      : `work:${task.taskId}`;
    return {
      id: canonicalId,
      turnId: task.targetTurnId ?? `work:${task.taskId}`,
      turnStatus: userMessageStatus,
      type: "userMessage",
      title: presentation.presentationRole === "collaboration"
        ? "Agent Collaboration"
        : presentation.presentationRole === "system_event"
          ? "System Event"
          : (task.source?.type === "feishu" ? "IMgateway" : "User"),
      text: task.text,
      images: task.source?.messageContent?.images ?? [],
      status: task.status,
      userMessageStatus,
      deletionAvailable: task.kind === "user" && ["failed", "cancelled"].includes(task.status)
        && userMessageDeletionEligibility(store, sessionId, canonicalId).available,
      queuePosition: Number(queuePosition) > 0 ? Number(queuePosition) : null,
      processingError: task.lastError ?? null,
      createdAt: task.createdAt,
      sourceType: presentation.presentationRole === "system_event" ? "system" : task.kind,
      sourceChannel: task.source?.type ?? null,
      localVisibility: task.localVisibility,
      feishuVisibility: task.source?.type === "feishu" ? "hidden" : null,
      taskId: task.taskId,
      ...(task.kind === "user" && task.source?.type === "scheduled_session_task" ? {
        messageOrigin: "scheduled_task",
        automationId: task.source.automationId ?? task.source.scheduledTaskId,
        automationRunId: task.source.scheduledRunId,
        automationName: task.source.automationName ?? null
      } : {}),
      collaborationRequestId: task.source?.taskId ?? null,
      ...presentation
    };
  }

  function collaborationConfirmationTimelineItem(confirmation, sessionId) {
    if (!confirmation?.confirmationId) return null;
    const request = confirmation.request ?? {};
    const recipientLogical = confirmation.recipientSessionId
      ? (store.getLogicalSession(confirmation.recipientSessionId)
        ?? store.getLogicalSessionByLegacySessionId(confirmation.recipientSessionId))
      : null;
    const recipientProviderSessionId = recipientLogical?.legacySessionId ?? null;
    const recipientSession = recipientProviderSessionId
      ? store.getSession(recipientProviderSessionId)
      : null;
    const initiatorLogical = confirmation.initiatorSessionId
      ? (store.getLogicalSession(confirmation.initiatorSessionId)
        ?? store.getLogicalSessionByLegacySessionId(confirmation.initiatorSessionId))
      : null;
    const confirmationTask = request.taskId ? store.getTask(request.taskId) : null;
    return {
      id: `collaboration-confirmation:${confirmation.confirmationId}`,
      turnId: confirmation.sourceTurnId ?? `collaboration-confirmation:${confirmation.confirmationId}`,
      turnStatus: confirmation.status === "pending" ? "waiting_approval" : "completed",
      type: "collaborationConfirmation",
      title: "Confirm Agent Collaboration",
      text: "",
      status: confirmation.status,
      createdAt: confirmation.createdAt,
      sourceType: "collaboration_confirmation",
      presentationRole: "collaboration_confirmation",
      presentationText: request.summary,
      collaborationConfirmationId: confirmation.confirmationId,
      collaborationSenderAgentId: confirmation.initiatorAgentId,
      collaborationSenderName: confirmation.initiatorAgentName,
      collaborationRecipientAgentId: confirmation.recipientAgentId,
      collaborationRecipientName: confirmation.recipientAgentName,
      collaborationInitiatorSessionId: confirmation.initiatorSessionId,
      collaborationInitiatorSessionTitle: confirmation.initiatorSessionTitle ?? initiatorLogical?.sessionName ?? null,
      collaborationInitiatorSessionKind: confirmation.initiatorSessionKind,
      collaborationRecipientSessionId: confirmation.recipientSessionId,
      collaborationRecipientSessionTitle: confirmation.recipientSessionTitle ?? recipientSession?.title ?? null,
      collaborationRecipientSessionKind: confirmation.recipientSessionKind,
      collaborationSourceWorkId: confirmation.sourceWorkId,
      collaborationSourceWorkName: confirmation.sourceWorkName,
      collaborationTargetWorkId: confirmation.targetWorkId,
      collaborationTargetWorkName: confirmation.targetWorkName,
      collaborationSourceTaskId: confirmation.initiatorTaskId ?? request.sourceTaskId ?? null,
      collaborationTargetTaskId: confirmation.recipientTaskId ?? request.taskId ?? null,
      collaborationRelation: confirmationTask?.collaboration_relation ?? null,
      collaborationRouteStatus: request.routeStatus ?? "pending",
      collaborationRoutingVersion: request.routingVersion ?? null,
      collaborationRequestTitle: request.title,
      collaborationMessageKind: request.type,
      collaborationAcceptanceCriteria: request.acceptanceCriteria ?? [],
      collaborationConfirmationStatus: confirmation.status,
      collaborationRequestId: confirmation.taskId,
      productSessionId: sessionId
    };
  }

  function sessionChannelAuthorizationTimelineItem(channelRequest, sessionId) {
    if (!channelRequest?.requestId) return null;
    const request = channelRequest.request ?? {};
    const sourceLogical = store.getLogicalSession(channelRequest.requestingSessionId);
    const recipientLogical = channelRequest.requestedRecipientSessionId
      ? store.getLogicalSession(channelRequest.requestedRecipientSessionId)
      : null;
    const sourceSession = sourceLogical?.legacySessionId ? store.getSession(sourceLogical.legacySessionId) : null;
    const recipientSession = recipientLogical?.legacySessionId ? store.getSession(recipientLogical.legacySessionId) : null;
    const sourceWorkId = sourceSession?.workId ?? request.sourceContext?.workId ?? null;
    const targetWorkId = recipientSession?.workId ?? request.targetWorkId ?? null;
    const workPresentation = collaborationWorkPresentation(store, { sourceWorkId, targetWorkId });
    const status = channelRequest.status ?? "pending";
    return {
      id: `session-channel-authorization:${channelRequest.requestId}`,
      turnId: `session-channel-authorization:${channelRequest.requestId}`,
      turnStatus: status === "pending" ? "waiting_approval" : "completed",
      type: "collaborationConfirmation",
      title: "Authorize Session Channel",
      text: "",
      status,
      createdAt: channelRequest.createdAt,
      sourceType: "session_channel_authorization",
      presentationRole: "collaboration_confirmation",
      presentationText: request.summary ?? request.body ?? "",
      collaborationConfirmationId: channelRequest.requestId,
      collaborationAuthorizationKind: "session_channel",
      collaborationInitiatorSessionId: channelRequest.requestingSessionId,
      collaborationInitiatorSessionTitle: sourceLogical?.sessionName ?? sourceSession?.title ?? null,
      collaborationInitiatorSessionKind: sourceSession?.sessionKind ?? null,
      collaborationRecipientSessionId: channelRequest.requestedRecipientSessionId,
      collaborationRecipientSessionTitle: recipientLogical?.sessionName ?? recipientSession?.title ?? request.title ?? null,
      collaborationRecipientSessionKind: recipientSession?.sessionKind ?? null,
      ...workPresentation,
      collaborationSourceTaskId: sourceSession?.taskId ?? request.sourceContext?.taskId ?? null,
      collaborationTargetTaskId: recipientSession?.taskId ?? request.taskId ?? null,
      collaborationMessageKind: request.messageKind ?? "message",
      collaborationConfirmationStatus: status,
      collaborationChannelId: channelRequest.channelId ?? null,
      productSessionId: sessionId
    };
  }

  function sessionChannelMessageTimelineItem(payload, sessionId) {
    const message = payload?.message;
    const channel = payload?.channel;
    if (!message?.messageId || !channel?.channelId || !message.senderSessionId || !message.recipientSessionId) {
      return null;
    }
    const senderLogical = store.getLogicalSession(message.senderSessionId);
    const recipientLogical = store.getLogicalSession(message.recipientSessionId);
    const senderSession = senderLogical?.legacySessionId ? store.getSession(senderLogical.legacySessionId) : null;
    const recipientSession = recipientLogical?.legacySessionId ? store.getSession(recipientLogical.legacySessionId) : null;
    const senderAgent = senderSession?.agentId ? store.getAgent(senderSession.agentId) : null;
    const recipientAgent = recipientSession?.agentId ? store.getAgent(recipientSession.agentId) : null;
    const resources = message.resourceContext ?? {};
    const sourceWorkId = resources.sender?.workId ?? senderSession?.workId ?? null;
    const targetWorkId = resources.recipient?.workId ?? recipientSession?.workId ?? null;
    const workPresentation = collaborationWorkPresentation(store, { sourceWorkId, targetWorkId });
    return {
      id: `session-channel-message:${message.messageId}:outbound`,
      turnId: `session-channel-message:${message.messageId}`,
      turnStatus: "completed",
      type: "userMessage",
      title: "Session Channel Message",
      text: message.body,
      status: "sent",
      userMessageStatus: "consumed",
      createdAt: message.createdAt,
      sourceType: "session_channel",
      sourceChannel: "session_channel",
      presentationRole: "collaboration",
      presentationText: message.body,
      collaborationDirection: "outbound",
      collaborationSenderAgentId: senderSession?.agentId ?? resources.sender?.agentId ?? null,
      collaborationSenderName: senderAgent?.name ?? null,
      collaborationRecipientAgentId: recipientSession?.agentId ?? resources.recipient?.agentId ?? null,
      collaborationRecipientName: recipientAgent?.name ?? null,
      collaborationInitiatorSessionId: message.senderSessionId,
      collaborationInitiatorSessionTitle: senderLogical?.sessionName ?? senderSession?.title ?? null,
      collaborationInitiatorSessionKind: senderSession?.sessionKind ?? null,
      collaborationRecipientSessionId: message.recipientSessionId,
      collaborationRecipientSessionTitle: recipientLogical?.sessionName ?? recipientSession?.title ?? null,
      collaborationRecipientSessionKind: recipientSession?.sessionKind ?? null,
      ...workPresentation,
      collaborationSourceTaskId: resources.sender?.taskId ?? senderSession?.taskId ?? null,
      collaborationTargetTaskId: resources.recipient?.taskId ?? recipientSession?.taskId ?? null,
      collaborationMessageKind: message.messageKind ?? "message",
      collaborationProcessingStatus: "sent",
      collaborationChannelId: channel.channelId,
      productSessionId: sessionId
    };
  }

  function collaborationPresentationForTask(task, sessionId = task.sessionId) {
    if (task.kind !== "collaboration") return {};
    if (task.source?.type === "session_channel") {
      const envelope = task.deliveryId
        ? sessionChannelService.getDeliveryEnvelope(task.deliveryId)
        : null;
      if (!envelope) {
        return {
          presentationRole: "system_event",
          presentationText: "A Session Channel message could not be verified.",
          systemEventKind: "invalid_session_channel_envelope",
          systemEventReason: "CHANNEL_DELIVERY_ENVELOPE_MISSING",
          systemEventSource: "session_channel"
        };
      }
      const senderSession = collaborationSessionPresentation(envelope.message.senderSessionId);
      const recipientSession = collaborationSessionPresentation(envelope.message.recipientSessionId);
      const resources = envelope.message.resourceContext ?? {};
      const workPresentation = collaborationWorkPresentation(store, {
        sourceWorkId: resources.sender?.workId ?? null,
        targetWorkId: resources.recipient?.workId ?? null
      });
      return {
        presentationRole: "collaboration",
        presentationText: envelope.message.body,
        collaborationDirection: "inbound",
        collaborationSenderAgentId: envelope.message.senderAgentId,
        collaborationSenderName: envelope.message.senderAgentName,
        collaborationRecipientAgentId: envelope.message.recipientAgentId,
        collaborationRecipientName: envelope.message.recipientAgentName,
        collaborationInitiatorSessionId: envelope.message.senderSessionId,
        collaborationInitiatorSessionTitle: senderSession?.title ?? null,
        collaborationInitiatorSessionKind: senderSession?.sessionKind ?? null,
        collaborationRecipientSessionId: envelope.message.recipientSessionId,
        collaborationRecipientSessionTitle: recipientSession?.title ?? null,
        collaborationRecipientSessionKind: recipientSession?.sessionKind ?? null,
        ...workPresentation,
        collaborationSourceTaskId: resources.sender?.taskId ?? null,
        collaborationTargetTaskId: resources.recipient?.taskId ?? null,
        collaborationMessageKind: envelope.message.messageKind,
        collaborationProcessingStatus: task.status,
        collaborationChannelId: envelope.channel.channelId
      };
    }
    const taskId = task.source?.taskId ?? null;
    const collaborationTask = taskId && collaborationCore.hasTask(taskId) ? { taskId } : null;
    const envelope = task.deliveryId
      ? collaborationCore.getDeliveryEnvelope(task.deliveryId)
      : null;
    const failure = collaborationEnvelopeFailure({ task, collaborationTask, envelope });
    if (failure) {
      return {
        presentationRole: "system_event",
        presentationText: "A collaboration-shaped event could not be verified and is not executable.",
        systemEventKind: "invalid_collaboration_envelope",
        systemEventReason: failure,
        systemEventSource: task.source?.type ?? "unknown",
        rawEventEnvelope: JSON.stringify({
          eventType: "AgentTask",
          timestamp: task.createdAt ?? null,
          source: task.source ?? null,
          envelope: envelope ?? null
        })
      };
    }
    const route = collaborationMessagePresentationRoute(envelope);
    const sender = route.senderAgentId ? collaborationCore.getAgent(route.senderAgentId) : null;
    const recipient = route.recipientAgentId ? collaborationCore.getAgent(route.recipientAgentId) : null;
    const sourceSession = collaborationSessionPresentation(route.sourceSessionId);
    const targetSession = collaborationSessionPresentation(route.targetSessionId);
    const targetTaskId = envelope?.task.taskId ?? task.source?.targetTaskId ?? null;
    const targetTask = targetTaskId ? store.getTask(targetTaskId) : null;
    const sourceWorkId = route.sourceWorkId ?? task.source?.sourceWorkId ?? null;
    const targetWorkId = route.targetWorkId ?? task.source?.targetWorkId ?? null;
    const workPresentation = collaborationWorkPresentation(store, { sourceWorkId, targetWorkId });
    return {
      presentationRole: "collaboration",
      presentationText: envelope.message.body,
      collaborationDirection: "inbound",
      collaborationSenderAgentId: route.senderAgentId ?? task.source?.senderAgentId ?? null,
      collaborationSenderName: sender?.name ?? envelope?.message.senderAgentName ?? task.source?.senderAgentName ?? route.senderAgentId,
      collaborationRecipientAgentId: route.recipientAgentId ?? task.agentId,
      collaborationRecipientName: recipient?.name ?? route.recipientAgentId,
      collaborationInitiatorSessionId: route.sourceSessionId ?? task.source?.initiatorSessionId ?? null,
      collaborationInitiatorSessionTitle: route.sourceSessionTitle ?? sourceSession?.title ?? null,
      collaborationInitiatorSessionKind: sourceSession?.sessionKind ?? null,
      collaborationRecipientSessionId: route.targetSessionId ?? task.source?.recipientSessionId ?? sessionId ?? null,
      collaborationRecipientSessionTitle: route.targetSessionTitle ?? targetSession?.title ?? null,
      collaborationRecipientSessionKind: targetSession?.sessionKind ?? null,
      ...workPresentation,
      collaborationRequestTitle: envelope?.task.title ?? task.source?.taskTitle ?? null,
      collaborationSourceTaskId: envelope?.task.sourceTaskId ?? task.source?.sourceTaskId ?? null,
      collaborationTargetTaskId: targetTaskId,
      collaborationRelation: targetTask?.collaboration_relation ?? task.source?.relationship ?? null,
      collaborationRouteStatus: envelope?.task.routeStatus ?? task.source?.routeStatus ?? null,
      collaborationRoutingVersion: envelope?.task.routingVersion ?? task.source?.routingVersion ?? null,
      collaborationMessageKind: envelope?.message.messageType ?? task.source?.messageKind ?? "message",
      collaborationProcessingStatus: task.status
    };
  }

  function collaborationSessionPresentation(sessionId) {
    if (!sessionId) return null;
    const logical = store.getLogicalSession(sessionId) ?? store.getLogicalSessionByLegacySessionId(sessionId);
    const providerSessionId = logical?.legacySessionId ?? sessionId;
    const session = store.getSession(providerSessionId);
    if (!logical && !session) return null;
    return {
      title: logical?.sessionName ?? session?.title ?? null,
      sessionKind: session?.sessionKind ?? null
    };
  }

  return { agentWorkTimelineItem, collaborationConfirmationTimelineItem, sessionChannelAuthorizationTimelineItem, sessionChannelMessageTimelineItem };
}
