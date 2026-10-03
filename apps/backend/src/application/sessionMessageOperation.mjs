import { randomUUID } from "node:crypto";
import { normalizeConversationMessage } from "./conversationMessage.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { assertAgentWorkSessionReference, shouldReportAgentWorkQueued } from "../utils/agentWorkQueue.mjs";
import { normalizeSessionMessageLatencyTrace, logSessionMessageLatency } from "../utils/sessionMessageLatency.mjs";
import { isClearCommand, parseSlashCommand } from "../commands/unifiedCommands.mjs";
import { workspaceTransitionBlocksWork } from "../runtime/workspaceTransitionBarrier.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { providerDeliveryFailureStatus } from "./providerDeliveryStatus.mjs";

// Provider-neutral message admission and dispatch. Delivery/Turn authority and
// the queue remain existing services; this module defines their ordered use.
export function createSessionMessageOperation({
  store, requireSessionReference, agentProviderRegistry, sessionChannelService,
  resolveSessionChannelRequest, collaborationCore, resolveCollaborationConfirmation,
  sessionBindingReadinessProbe, sessionApplicationService, emitEvent, now,
  decorateSessionForClient, chatResourceService, providerTurnResponseWatchdog,
  ensureCollaborationAgentForSession, registerRuntimeQueuedWork,
  runtimeQueuePosition, publishProviderEventOutbox, scheduleAgentWorkDrain,
  scheduleMemoryExtraction = null
}) {
async function sendUnifiedSessionMessage(sessionId, input, source = { type: "desktop" }, options = {}) {
  const message = normalizeConversationMessage(input);
  const value = message.text;
  const reference = requireSessionReference(sessionId);
  assertSessionRecoveryMessageBoundary(reference);
  if (message.images.length > 0 && !agentProviderRegistry.supports(
    reference.providerId,
    AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND_IMAGE
  )) {
    const error = new Error("This Agent Provider does not support image messages.");
    error.code = "PROVIDER_CAPABILITY_UNSUPPORTED";
    error.statusCode = 409;
    throw error;
  }
  if (options.agentTask) assertAgentWorkSessionReference(options.agentTask, reference);
  const routedSessionId = reference.sessionId;
  const publicSessionId = reference.logicalSessionId ?? routedSessionId;
  const before = reference.metadata.session;
  const latencyTrace = normalizeSessionMessageLatencyTrace(
    options.latencyTrace ?? source.latencyTrace ?? {},
    { sessionId: publicSessionId }
  );

  const confirmationReply = message.images.length === 0 ? collaborationConfirmationReply(value) : null;
  const pendingChannelRequest = confirmationReply
    ? sessionChannelService.pendingRequestForSession(publicSessionId)
    : null;
  if (pendingChannelRequest) {
    const request = await resolveSessionChannelRequest(
      pendingChannelRequest.requestId,
      confirmationReply === "confirm",
      source
    );
    return { accepted: true, mode: "session-channel-authorization", sessionId: publicSessionId, channelRequest: request };
  }
  const pendingConfirmation = confirmationReply
    ? collaborationCore.pendingTaskConfirmationForSession(routedSessionId)
    : null;
  if (pendingConfirmation) {
    const confirmation = await resolveCollaborationConfirmation(
      pendingConfirmation.confirmationId,
      confirmationReply === "confirm",
      source
    );
    return { accepted: true, mode: "collaboration-confirmation", sessionId: publicSessionId, collaborationConfirmation: confirmation };
  }

  // A successful probe is scoped to the exact logical Session + Binding
  // generation. Reuse that proof until Provider restart, route replacement,
  // or a failed dispatch invalidates it; ordinary messages must not resume the
  // same Provider thread merely to rediscover that it is still present.
  const bindingVerification = await sessionBindingReadinessProbe.verify(
    routedSessionId,
    { reuseReady: true }
  );
  if (bindingVerification.ready !== true) {
    const error = new Error(
      bindingVerification.readiness?.message ?? "The Provider Session is unavailable."
    );
    error.code = "SESSION_NOT_READY";
    error.reason = bindingVerification.readiness?.reasonCode ?? "PROVIDER_SESSION_UNAVAILABLE";
    throw error;
  }

  const slashCommand = parseSlashCommand(value);
  if (slashCommand && !(isClearCommand(value) && message.images.length === 0) && options.fromAgentWorkQueue !== true && !options.agentTask
      && ["desktop", "feishu", "remote-client"].includes(source.type)) {
    if (message.images.length > 0) {
      throw Object.assign(new Error("斜杠命令不支持附带图片，请单独发送命令。"), {
        code: "INVALID_COMMAND_ARGUMENTS", statusCode: 400
      });
    }
    if (workspaceTransitionBlocksWork(store.getLogicalSessionByLegacySessionId(routedSessionId))) {
      throw Object.assign(new Error("会话正在切换工作目录，请完成后再执行命令。"), {
        code: "SESSION_BUSY", statusCode: 409
      });
    }
    if (["compact", "review", "model", "reasoning", "rename"].includes(slashCommand.name)
        && (sessionHasActiveRun(before) || store.listUnsettledSessionTurns(routedSessionId).length > 0)) {
      throw Object.assign(new Error(`/${slashCommand.name} 请在当前执行结束后使用。`), {
        code: "SESSION_BUSY", statusCode: 409
      });
    }
    if (slashCommand.name === "compact") scheduleMemoryExtraction?.(routedSessionId, "pre_compaction");
    const result = await sessionApplicationService.executeCommand(sessionId, slashCommand, { before, source });
    const id = `command:${randomUUID()}`;
    const item = {
      id, turnId: id, turnStatus: "completed", type: "commandExecution",
      title: `/${slashCommand.name}`, text: result.text, status: "completed", createdAt: now(),
      sourceType: "session_command"
    };
    emitEvent("SessionCommandCompleted", { item }, { sessionId: routedSessionId, source });
    return { accepted: true, mode: "session-command", sessionId: publicSessionId, warning: result.text, commandMessageId: id };
  }

  if (options.fromAgentWorkQueue !== true) {
    const presented = decorateSessionForClient(before);
    if (presented.readiness !== "ready") {
      const error = new Error(
        presented.notReadyReason?.message ?? "This Session is not ready to accept messages."
      );
      error.code = "SESSION_NOT_READY";
      error.reason = presented.notReadyReason?.code ?? "SESSION_NOT_READY";
      throw error;
    }
  }

  if (message.images.length === 0 && isClearCommand(value)) {
    const result = await sessionApplicationService.clearConversation(sessionId, { before, source });
    if (result?.cleared === true) return result;
    store.clearItems(routedSessionId);
    const session = {
      ...result,
      id: routedSessionId
    };
    emitEvent("SessionCleared", {
      previousSessionId: routedSessionId,
      session,
      source
    }, { sessionId: routedSessionId, source });
    return {
      accepted: true,
      cleared: true,
      previousSessionId: routedSessionId,
      sessionId: publicSessionId,
      legacySessionId: routedSessionId,
      session
    };
  }

  if (options.fromAgentWorkQueue !== true) {
    return enqueueUserAgentWork(before, message, source, latencyTrace, reference);
  }
  if (sessionHasActiveRun(before) || store.listUnsettledSessionTurns(routedSessionId).length > 0) {
    const error = new Error("Target Session became busy before queued work started.");
    error.code = "SESSION_BUSY";
    throw error;
  }

  const deliveryId = source.deliveryId ?? options.agentTask?.source?.deliveryId ?? null;
  const delivery = deliveryId ? store.getMessageDelivery(deliveryId) : null;
  if (delivery) {
    store.updateMessageDelivery(deliveryId, {
      status: "dispatching",
      attemptCount: delivery.attemptCount + 1,
      lastAttemptAt: now(),
      lastError: null
    });
  }
  logSessionMessageLatency(latencyTrace, "provider_dispatch_started", {
    providerId: reference.providerId
  });
  let result;
  try {
    result = await sessionApplicationService.sendMessage(
      sessionId,
      await resolvedConversationMessage(reference, message),
      {
      before,
      latencyTrace,
      options,
      source,
      submit: options.submit,
      idempotencyKey: deliveryId
      }
    );
  } catch (error) {
    // A failed Provider dispatch makes the last-known-ready proof suspect. The
    // next dispatch performs one real probe before retrying this Binding.
    sessionBindingReadinessProbe.invalidateBinding(reference);
    if (delivery) {
      const status = providerDeliveryFailureStatus(error);
      store.updateMessageDelivery(deliveryId, {
        status,
        lastError: error.message
      });
      error.deliveryStatus = status;
    }
    throw error;
  }
  const providerTurnId = result?.turn?.id ?? result?.turnId ?? null;
  const routedDelivery = delivery ? store.getMessageDelivery(deliveryId) ?? delivery : null;
  const dispatchBindingId = routedDelivery?.bindingId ?? reference.bindingId;
  const dispatchBinding = dispatchBindingId ? store.getAgentSessionBinding(dispatchBindingId) : null;
  // Command acceptance is a durable Provider-neutral execution fact. Persist a
  // running Turn before returning so orphan reconciliation cannot cancel work
  // merely because a Provider's first realtime lifecycle event is delayed.
  // Native events may already have won the race; never overwrite a settled Turn.
  // Recovery may have atomically rebound the durable Delivery while sendMessage
  // was in flight, so prefer that post-CAS binding over the pre-dispatch reference.
  if (providerTurnId && dispatchBindingId
    && !store.getSessionTurn(routedSessionId, dispatchBindingId, providerTurnId)) {
    const timestamp = now();
    store.upsertSessionTurn({
      sessionId: routedSessionId,
      bindingId: dispatchBindingId,
      routingVersion: dispatchBinding?.routingVersion ?? reference.routingVersion,
      turnId: providerTurnId,
      executionStatus: "running",
      startedAt: timestamp,
      updatedAt: timestamp
    });
  }
  if (providerTurnId && dispatchBinding) {
    providerTurnResponseWatchdog.watch({
      sessionId: routedSessionId,
      logicalSessionId: dispatchBinding.logicalSessionId ?? reference.logicalSessionId,
      providerId: dispatchBinding.providerId ?? reference.providerId,
      providerSessionId: dispatchBinding.providerSessionId ?? reference.providerSessionId,
      bindingId: dispatchBinding.bindingId,
      routingVersion: dispatchBinding.routingVersion ?? reference.routingVersion,
      turnId: providerTurnId,
      startedAt: now()
    });
  }
  if (delivery) {
    const alreadySettledTurn = providerTurnId
      ? store.getSessionTurn(routedSessionId, routedDelivery.bindingId, providerTurnId)
      : null;
    const acknowledgedStatus = alreadySettledTurn
      ? ({ completed: "completed", failed: "failed", cancelled: "cancelled" }[alreadySettledTurn.execution_status]
        ?? "accepted")
      : "accepted";
    store.updateMessageDelivery(deliveryId, {
      status: acknowledgedStatus,
      providerTurnId,
      providerAcknowledgedAt: now(),
      lastError: null
    });
  }
  logSessionMessageLatency(latencyTrace, "provider_dispatch_completed", {
    providerId: reference.providerId,
    turnId: result?.turn?.id ?? result?.turnId ?? null
  });
  logSessionMessageLatency(latencyTrace, "session_execution_started", {
    providerId: reference.providerId,
    turnId: result?.turn?.id ?? result?.turnId ?? null
  });

  emitEvent("SessionRunStarted", {
    sessionId: routedSessionId,
    logicalSessionId: reference.logicalSessionId,
    source
  }, { sessionId: routedSessionId, source });
  return {
    accepted: true,
    cleared: false,
    sessionId: publicSessionId,
    legacySessionId: routedSessionId,
    result
  };
}

function assertSessionRecoveryMessageBoundary(reference) {
  const logicalSessionId = reference?.logicalSessionId ?? null;
  const legacySessionId = reference?.sessionId ?? null;
  const logical = logicalSessionId
    ? store.getLogicalSession(logicalSessionId)
    : legacySessionId
      ? store.getLogicalSessionByLegacySessionId(legacySessionId)
      : null;
  if (logical?.transitionState !== "sessionRecovery") return;
  const error = new Error("The Session is recovering. Sending messages is temporarily unavailable.");
  error.code = "SESSION_BUSY";
  error.reason = "sessionRecovery";
  throw error;
}

function collaborationConfirmationReply(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["确认", "确认发送", "发送", "同意", "yes", "y", "confirm", "approve"].includes(normalized)) return "confirm";
  if (["取消", "拒绝", "不发送", "否", "no", "n", "reject", "cancel"].includes(normalized)) return "reject";
  return null;
}


async function resolvedConversationMessage(reference, input) {
  const message = normalizeConversationMessage(input);
  const images = [];
  for (const image of message.images) {
    const stored = await chatResourceService.readImage(reference, image.managedPath);
    images.push({
      ...image,
      absolutePath: stored.path,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength
    });
  }
  return { text: message.text, images, ...(message.mentions ? { mentions: message.mentions } : {}) };
}

function enqueueUserAgentWork(session, input, source, latencyTrace = null, reference = null) {
  const message = normalizeConversationMessage(input);
  const agent = collaborationCore.getAgentForSession(session.id) ?? ensureCollaborationAgentForSession(session);
  if (!agent) {
    const error = new Error("Session does not have an Agent identity.");
    error.code = "AGENT_NOT_FOUND";
    throw error;
  }
  const activeRun = sessionHasActiveRun(session);
  const hasRunningTask = Boolean(store.getRunningAgentTaskForSession(session.id));
  const logical = reference?.logicalSessionId
    ? store.getLogicalSession(reference.logicalSessionId)
    : store.getLogicalSessionByLegacySessionId(session.id);
  const binding = logical?.activeBinding;
  if (!binding) {
    const error = new Error("Session does not have an active Provider Binding.");
    error.code = "SESSION_BINDING_NOT_FOUND";
    throw error;
  }
  const messageId = source.messageId || randomUUID();
  const deliveryId = source.deliveryId || `delivery:${messageId}`;
  const persistedSource = {
    ...source,
    messageId,
    deliveryId,
    messageContent: message,
    ...(latencyTrace ? { latencyTrace } : {})
  };
  const created = store.createUserMessageDelivery({
    deliveryId,
    messageId,
    sessionId: session.id,
    binding,
    agentId: agent.agentId,
    text: message.text,
    content: message,
    title: source.type === "feishu" ? "IMgateway" : "User",
    source: persistedSource,
    createdAt: now()
  });
  const task = created.task;
  registerRuntimeQueuedWork(session.id, task.taskId);
  const queuePosition = runtimeQueuePosition(session.id, task.taskId);
  const reportAsQueued = shouldReportAgentWorkQueued({
    sessionHasActiveRun: activeRun,
    hasRunningTask,
    queuedTasksAhead: Math.max(0, queuePosition - 1)
  });
  logSessionMessageLatency(latencyTrace, "task_enqueued", { queuePosition });
  if (created.outbox) publishProviderEventOutbox([created.outbox]);
  emitEvent("AgentWorkQueued", { sessionId: session.id, task, queuePosition, source: persistedSource }, { sessionId: session.id, source: persistedSource });
  scheduleAgentWorkDrain(session.id, latencyTrace, task.taskId);
  return {
    accepted: true,
    queued: reportAsQueued,
    queuePosition: reportAsQueued ? queuePosition : 0,
    sessionId: session.id,
    task
  };
}

  return { sendUnifiedSessionMessage, assertSessionRecoveryMessageBoundary };
}
