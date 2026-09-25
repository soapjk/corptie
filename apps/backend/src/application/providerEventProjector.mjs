import { executionPlanItem, finishExecutionPlan, patchExecutionPlan, replaceExecutionPlan, sameExecutionPlanContent, uncertainExecutionPlan } from "./executionPlanProjection.mjs";

const TERMINAL_EVENT_STATUS = new Map([
  ["turn.completed", "completed"],
  ["turn.failed", "failed"],
  ["turn.cancelled", "cancelled"]
]);

const ITEM_EVENT_TYPES = new Set([
  "user.message.accepted",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "interaction.requested",
  "interaction.submitted",
  "interaction.resolved"
]);

export class ProviderEventProjector {
  constructor({ store }) {
    if (!store?.upsertSessionTurn || !store?.upsertTimelineItemProjection) {
      throw new Error("ProviderEventProjector requires a Provider event projection Store.");
    }
    this.store = store;
  }

  project({ event, binding }) {
    const sessionId = binding.sessionId;
    const session = this.store.getSession(sessionId);
    if (!session) throw projectionError("SESSION_NOT_FOUND", `Session ${sessionId} is not registered.`);

    const correlatedDelivery = event.turnId
      ? this.store.getMessageDeliveryForProviderTurn?.(sessionId, event.bindingId, event.turnId)
        ?? this.store.claimDispatchingMessageDeliveryForProviderTurn?.(
          sessionId,
          event.bindingId,
          event.turnId,
          event.receivedAt
        )
      : null;
    const correlatedWork = event.turnId
      ? this.store.getAgentTaskForTurn?.(sessionId, event.turnId)
        ?? this.store.claimRunningAgentTaskForProviderTurn?.(sessionId, event.turnId)
      : null;
    let timelineChanged = false;
    let usage = null;
    if (event.type === "usage.updated") {
      const context = normalizeContextUsage(event.payload?.tokenUsage ?? event.payload?.usage);
      if (context) {
        usage = this.store.upsertSessionUsageSnapshot({
          sessionId,
          providerId: event.providerId,
          model: session.external?.currentModel ?? null,
          context,
          updatedAt: event.receivedAt
        });
      }
    }
    if (ITEM_EVENT_TYPES.has(event.type) && event.payload?.item) {
      const settledTurnStatus = event.type.startsWith("interaction.") && event.turnId
        ? this.store.getSessionTurn?.(sessionId, event.bindingId, event.turnId)?.execution_status
        : null;
      timelineChanged = this.persistItem(
        sessionId,
        ["completed", "failed", "cancelled"].includes(settledTurnStatus)
          ? { ...event.payload.item, turnStatus: settledTurnStatus,
            status: event.payload.item.status === "pending" ? "expired" : event.payload.item.status }
          : event.payload.item,
        event.bindingId,
        correlatedDelivery,
        correlatedWork
      ) || timelineChanged;
    }
    if (event.type === "plan.updated" && event.turnId) {
      const settledTurnStatus = this.store.getSessionTurn?.(sessionId, event.bindingId, event.turnId)?.execution_status;
      const isSessionTaskList = event.payload?.plan?.planKey === "claude-tasks";
      const planId = isSessionTaskList
        ? `execution-plan:${event.bindingId}:${event.turnId}:claude-tasks`
        : `execution-plan:${event.bindingId}:${event.turnId}`;
      const existing = this.store.getSessionItem(sessionId, planId);
      const previous = existing?.executionPlan ?? (isSessionTaskList
        ? this.store.getExecutionPlanState(sessionId, event.bindingId, "claude-tasks")
        : null);
      const context = {
        planId,
        updatedAt: event.occurredAt ?? event.receivedAt
      };
      const plan = event.payload?.plan?.operation === "replace"
        ? replaceExecutionPlan(previous, event.payload.plan, context)
        : patchExecutionPlan(previous, event.payload?.plan, context);
      const projectedPlan = plan ?? (plan === undefined || event.payload?.plan == null
        ? uncertainExecutionPlan(previous, context) : null);
      // A valid late plan notification may fill in missing steps, but it must
      // never reopen a Turn that has already reached a durable terminal state.
      const nextPlan = projectedPlan && ["completed", "failed", "cancelled"].includes(settledTurnStatus)
        ? finishExecutionPlan(projectedPlan, settledTurnStatus, context.updatedAt, { incrementRevision: false })
          ?? projectedPlan
        : projectedPlan;
      if (nextPlan && !sameExecutionPlanContent(previous, nextPlan)) {
        if (isSessionTaskList && plan) {
          this.store.upsertExecutionPlanState(sessionId, event.bindingId, "claude-tasks", plan);
        }
        timelineChanged = this.persistItem(sessionId, executionPlanItem(nextPlan, {
          turnId: event.turnId,
          turnStatus: existing?.turnStatus && ["completed", "failed", "cancelled"].includes(existing.turnStatus)
            ? existing.turnStatus : "inProgress",
          createdAt: existing?.createdAt ?? event.occurredAt ?? event.receivedAt
        }), event.bindingId) || timelineChanged;
      }
    }
    if (TERMINAL_EVENT_STATUS.has(event.type)) {
      for (const item of event.payload?.items ?? []) {
        if (!event.turnId || item?.turnId === event.turnId) {
          timelineChanged = this.persistItem(
            sessionId,
            item,
            event.bindingId,
            correlatedDelivery,
            correlatedWork
          ) || timelineChanged;
        }
      }
      if (event.turnId) {
        for (const planId of [
          `execution-plan:${event.bindingId}:${event.turnId}`,
          `execution-plan:${event.bindingId}:${event.turnId}:claude-tasks`
        ]) {
          const existing = this.store.getSessionItem(sessionId, planId);
          const plan = finishExecutionPlan(existing?.executionPlan, TERMINAL_EVENT_STATUS.get(event.type), event.receivedAt);
          if (plan) {
            timelineChanged = this.persistItem(sessionId, executionPlanItem(plan, {
              turnId: event.turnId,
              turnStatus: TERMINAL_EVENT_STATUS.get(event.type),
              createdAt: existing.createdAt
            }), event.bindingId) || timelineChanged;
          }
        }
      }
    }
    if (event.type === "turn.failed" && event.turnId) {
      timelineChanged = this.persistItem(sessionId, {
        id: `turn-failure:${event.bindingId}:${event.turnId}`,
        turnId: event.turnId,
        turnStatus: "failed",
        type: "system",
        title: "执行失败",
        text: publicTurnFailureMessage(event.payload?.error),
        status: "failed",
        createdAt: event.occurredAt ?? event.receivedAt
      }, event.bindingId) || timelineChanged;
    }
    const projectedTurnItems = event.turnId
      ? this.store.getItemsForTurn?.(sessionId, event.turnId, session.external?.provider) ?? []
      : [];
    if (TERMINAL_EVENT_STATUS.has(event.type)) {
      for (const item of projectedTurnItems) {
        if (item.type !== "userInput" || item.bindingId !== event.bindingId) continue;
        if (!["pending", "dispatching", "submitted"].includes(item.status)) continue;
        timelineChanged = this.persistItem(sessionId, {
          ...item,
          turnStatus: TERMINAL_EVENT_STATUS.get(event.type),
          status: item.status === "pending" ? "expired" : item.status
        }, event.bindingId) || timelineChanged;
      }
    }
    const finalAgentMessage = event.type === "turn.completed"
      ? finalItemForTurn({ items: projectedTurnItems }, event.turnId)
      : null;
    const terminalOutcome = providerTerminalOutcome(event);

    const priorTurnStatus = event.type.startsWith("interaction.") && event.turnId
      ? this.store.getSessionTurn?.(sessionId, event.bindingId, event.turnId)?.execution_status
      : null;
    const turnStatus = ["completed", "failed", "cancelled"].includes(priorTurnStatus)
      ? null : projectedTurnStatus(event, terminalOutcome);
    if (turnStatus && event.turnId) {
      const finalItem = finalItemForTurn({ items: projectedTurnItems }, event.turnId);
      this.store.upsertSessionTurn({
        sessionId,
        bindingId: event.bindingId,
        routingVersion: event.routingVersion,
        turnId: event.turnId,
        executionStatus: turnStatus,
        finalItemId: finalItem?.id ?? null,
        startedAt: event.type === "turn.started" ? event.occurredAt ?? event.receivedAt : null,
        endedAt: TERMINAL_EVENT_STATUS.has(event.type) ? event.occurredAt ?? event.receivedAt : null,
        providerSequence: event.providerSequence,
        failure: terminalOutcome?.status === "failed" ? terminalOutcome.failure ?? {} : null,
        updatedAt: event.receivedAt
      });
      const delivery = correlatedDelivery ?? this.store.getMessageDeliveryForProviderTurn?.(
        sessionId,
        event.bindingId,
        event.turnId
      );
      if (delivery) {
        const deliveryStatus = terminalOutcome
          ? terminalOutcome.status
          : "processing";
        this.store.updateMessageDelivery(delivery.deliveryId, {
          status: deliveryStatus,
          lastError: terminalOutcome?.status === "failed"
            ? terminalOutcome.failure?.message ?? "Provider turn failed."
            : null
        });
      }
    }

    const updatedSession = this.projectSession(session, event, binding, terminalOutcome);
    const outbox = [];
    if (timelineChanged) {
      outbox.push({
        topic: "timeline",
        revision: this.store.sessionTimelineRevision(sessionId),
        eventType: "TimelineChanged",
        payload: {
          sessionId,
          revision: this.store.sessionTimelineRevision(sessionId),
          itemId: event.itemId ?? null,
          turnId: event.turnId ?? null
        }
      });
    }
    if (updatedSession) {
      outbox.push({
        topic: "state",
        eventType: "SessionStateChanged",
        payload: { session: updatedSession }
      });
    }
    return {
      surface: event.type === "user.message.accepted"
        || event.type === "assistant.message.completed"
        || (TERMINAL_EVENT_STATUS.has(event.type) && Boolean(finalAgentMessage)),
      // Unread state is a projection fact, not a Provider-specific hint. Only
      // a durable, non-empty final answer for this exact completed Turn may
      // advance the Agent-message high-water mark.
      hasAgentMessage: Boolean(finalAgentMessage),
      timelineChanged,
      session: updatedSession ?? session,
      usage,
      terminalStatus: terminalOutcome?.status ?? null,
      terminalFailure: terminalOutcome?.failure ?? null,
      outbox
    };
  }

  persistItem(sessionId, item, bindingId, delivery = null, task = null) {
    if (!item?.id) return false;
    let canonicalItem = item;
    if (item.type === "userMessage" && delivery) {
      canonicalItem = {
        ...item,
        id: delivery.messageId,
        turnId: delivery.providerTurnId ?? item.turnId,
        status: delivery.status
      };
    } else if (item.type === "userMessage" && task) {
      const canonicalId = task.kind === "user"
        ? (task.source?.messageId ?? task.taskId)
        : `work:${task.taskId}`;
      const existing = this.store.getSessionItem?.(sessionId, canonicalId);
      canonicalItem = {
        ...item,
        id: canonicalId,
        turnId: task.targetTurnId ?? item.turnId,
        title: existing?.title ?? item.title,
        status: task.status,
        presentationRole: existing?.presentationRole ?? item.presentationRole,
        presentationText: existing?.presentationText ?? item.presentationText,
        rawMetadataJSON: mergedItemMetadata(existing?.rawMetadataJSON, item.rawMetadataJSON, {
          taskId: task.taskId,
          sourceChannel: task.source?.type ?? null,
          collaborationRequestId: task.source?.taskId ?? null
        })
      };
    }
    return this.store.upsertTimelineItemProjection(sessionId, { ...canonicalItem, bindingId }) !== false;
  }

  projectSession(session, event, binding, terminalOutcome = null) {
    const unsettled = this.store.listUnsettledSessionTurns(binding.sessionId);
    const status = sessionStatus(event, unsettled, session.status, binding.isCurrentRoute !== false, terminalOutcome);
    const latestAgentItem = latestAgentItemFromPayload(event.payload);
    const activityStatus = status === "blocked"
      ? (event.type.startsWith("interaction.") ? "Waiting for input" : "Waiting for approval")
      : status === "running"
        ? activityForEvent(event)
        : null;
    const activeTurn = unsettled.findLast?.((turn) => turn.binding_id === binding.bindingId)
      ?? unsettled.at(-1)
      ?? null;
    const providerFailure = event.type === "provider.error"
      && event.payload?.willRetry !== true
      && event.payload?.failureScope !== "turn"
      ? normalizeProviderFailure(event.payload?.error)
      : null;
    const restoresSendAvailability = binding.isCurrentRoute !== false && (
      event.type === "turn.started"
      || TERMINAL_EVENT_STATUS.has(event.type)
      || (event.type === "provider.error" && event.payload?.failureScope === "turn")
    );
    const next = {
      ...session,
      status,
      progress: status === "running" || status === "blocked" ? 0.5 : 1,
      summary: latestAgentItem?.text || providerFailure?.message || session.summary,
      sendUnavailableReason: providerFailure?.message
        ?? (restoresSendAvailability ? null : session.sendUnavailableReason ?? null),
      activityStatus,
      suggestedOptions: event.type === "approval.requested"
        ? event.payload?.item?.options ?? session.suggestedOptions
        : session.suggestedOptions,
      suggestedPrompt: event.type === "approval.requested"
        ? event.payload?.item?.text ?? session.suggestedPrompt
        : session.suggestedPrompt,
      updatedAt: event.receivedAt,
      capabilities: {
        ...(session.capabilities ?? {}),
        ...(providerFailure
          ? { canSend: false }
          : (restoresSendAvailability ? { canSend: true } : {})),
        canInterrupt: unsettled.length > 0
      },
      external: {
        ...(session.external ?? {}),
        activeTurnId: activeTurn?.turn_id ?? null,
        lastSettledTurnId: TERMINAL_EVENT_STATUS.has(event.type)
          ? event.turnId ?? session.external?.lastSettledTurnId ?? null
          : session.external?.lastSettledTurnId ?? null,
        rawStatus: status
      }
    };
    if (sameSessionExecutionProjection(session, next)) return null;
    this.store.upsertSession({
      ...next,
      provider: next.external?.provider ?? binding.providerId,
      cwd: next.external?.cwd,
      command: next.external?.source ?? binding.providerId
    });
    return this.store.getSession(binding.sessionId);
  }
}

function mergedItemMetadata(existingJSON, incomingJSON, additions) {
  const parse = (value) => {
    if (typeof value !== "string" || !value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  return JSON.stringify({
    ...parse(existingJSON),
    ...parse(incomingJSON),
    ...Object.fromEntries(Object.entries(additions).filter(([, value]) => value != null))
  });
}

function normalizeContextUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const active = value.last ?? value.lastUsage ?? value.last_usage
    ?? value.total ?? value.totalUsage ?? value.total_usage ?? value;
  const usedTokens = finiteUsageNumber(
    active.usedTokens ?? active.totalTokens ?? active.total_tokens ?? value.usedTokens ?? value.totalTokens
  );
  const contextWindow = finiteUsageNumber(
    value.contextWindow ?? value.context_window ?? value.modelContextWindow ?? value.model_context_window
  );
  const remainingTokens = finiteUsageNumber(value.remainingTokens ?? value.remaining_tokens)
    ?? (usedTokens != null && contextWindow != null ? Math.max(0, contextWindow - usedTokens) : null);
  const usedPercent = finiteUsageNumber(value.usedPercent ?? value.used_percent)
    ?? (usedTokens != null && contextWindow ? Math.min(100, usedTokens / contextWindow * 100) : null);
  if ([usedTokens, contextWindow, remainingTokens, usedPercent].every((item) => item == null)) return null;
  return { usedTokens, contextWindow, remainingTokens, usedPercent };
}

function finiteUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function projectedTurnStatus(event, terminalOutcome = null) {
  if (terminalOutcome) return terminalOutcome.status;
  // Configuration notices belong to the timeline, not to an executing Turn.
  // Adapters may deliver them through the item stream while no Turn is active.
  if (ITEM_EVENT_TYPES.has(event.type) && event.payload?.item?.type === "system") return null;
  if (event.type === "approval.requested"
    || (["interaction.requested", "interaction.submitted"].includes(event.type)
      && event.payload?.item?.userInput?.isBlocking !== false
      && blockingUserInputMetadata(event.payload?.item?.rawMetadataJSON) !== false)) return "blocked";
  if (event.type.startsWith("interaction.") && event.turnId) return "running";
  if (event.type === "turn.started" || ITEM_EVENT_TYPES.has(event.type)) return "running";
  return null;
}

function sessionStatus(event, unsettled, previousStatus, isCurrentRoute, terminalOutcome = null) {
  if (unsettled.some((turn) => turn.execution_status === "blocked")) return "blocked";
  if (unsettled.length > 0) return "running";
  if (event.type === "provider.error" && isCurrentRoute) {
    return event.payload?.willRetry ? "running" : "failed";
  }
  const terminal = terminalOutcome?.status ?? TERMINAL_EVENT_STATUS.get(event.type);
  if (!terminal || !isCurrentRoute) return previousStatus;
  return terminal === "completed" ? "complete" : terminal;
}

function finalItemForTurn(payload, turnId) {
  return [...(payload?.items ?? [])].reverse().find((item) =>
    item?.turnId === turnId
    && item?.type === "agentMessage"
    && item?.presentationRole === "final_answer"
    && typeof item.text === "string"
    && item.text.trim()
  ) ?? null;
}

function providerTerminalOutcome(event) {
  const status = TERMINAL_EVENT_STATUS.get(event.type);
  if (!status) return null;
  // Tool failures describe individual attempts, not the outcome of the Turn.
  // A completed Turn may recover from an error or finish with a Channel send
  // and no final text. Preserve the Provider's explicit terminal status.
  return {
    status,
    failure: status === "failed" ? normalizeProviderFailure(event.payload?.error) : null
  };
}

function normalizeProviderFailure(error) {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = [error.message, error.error, error.detail]
      .find((value) => typeof value === "string" && value.trim())
      ?.trim()
      ?? "Provider turn failed.";
    return { ...error, message };
  }
  if (typeof error === "string" && error.trim()) return { message: error.trim() };
  return { message: "Provider turn failed." };
}

// Provider errors may contain host paths, credentials, or gateway internals.
// Only a small, actionable classification is allowed into the shared client timeline.
function publicTurnFailureMessage(error) {
  const failure = normalizeProviderFailure(error);
  const detail = String(failure.message ?? "");
  const code = String(failure.code ?? "").toUpperCase();
  if (code === "UPSTREAM_ACCOUNT_UNAVAILABLE" || /no eligible upstream account/i.test(detail)) {
    return "推理服务没有可用的上游账号。请检查网关账号状态后重试。";
  }
  if (code === "UPSTREAM_PROVIDER_UNAVAILABLE" || /all target providers failed/i.test(detail)) {
    return "推理网关的所有上游服务均请求失败。请检查网关和上游账号状态后重试。";
  }
  if (/model is at capacity|model.*overload|serverOverloaded/i.test(`${detail} ${code}`)) {
    return "模型服务当前容量不足。请稍后重试或切换模型。";
  }
  if (code === "AUTHENTICATION_FAILED" || /authentication failed/i.test(detail)) {
    return "模型服务认证失败。请检查当前 Provider 的凭据。";
  }
  if (code === "PERMISSION_DENIED" || /permission denied/i.test(detail)) {
    return "模型服务拒绝了请求。请检查账号和模型权限。";
  }
  if (code === "RATE_LIMITED" || /rate limit/i.test(detail)) {
    return "模型服务达到请求限额。请稍后重试。";
  }
  if (code === "REQUEST_TIMEOUT" || /timed? out/i.test(detail)) {
    return "模型服务请求超时。请检查网络后重试。";
  }
  if (code === "NETWORK_ERROR" || /network error/i.test(detail)) {
    return "无法连接模型服务。请检查网络或网关状态后重试。";
  }
  if (code === "PROVIDER_SERVICE_ERROR" || failure.statusCode === 503 || /service is temporarily unavailable/i.test(detail)) {
    const status = Number(failure.statusCode ?? failure.status);
    return `模型服务暂不可用${status === 503 ? "（HTTP 503）" : ""}。请检查网关及上游账号状态，或稍后重试。`;
  }
  return "本次模型执行失败。请检查 Provider 状态后重试。";
}

function latestAgentItemFromPayload(payload) {
  const items = payload?.items ?? (payload?.item ? [payload.item] : []);
  return [...items].reverse().find((item) =>
    item?.type === "agentMessage"
    && typeof item.text === "string"
    && item.text.trim()
  ) ?? null;
}

function activityForEvent(event) {
  if (event.type === "provider.error") return event.payload?.willRetry ? "Reconnecting" : null;
  if (event.type.startsWith("tool.")) return "Using tool";
  if (event.type.startsWith("assistant.message")) return "Responding";
  return "Working";
}

function blockingUserInputMetadata(rawMetadataJSON) {
  if (typeof rawMetadataJSON !== "string") return true;
  try {
    return JSON.parse(rawMetadataJSON)?.userInput?.isBlocking !== false;
  } catch {
    return true;
  }
}

function sameSessionExecutionProjection(left, right) {
  return left.status === right.status
    && left.progress === right.progress
    && left.summary === right.summary
    && left.sendUnavailableReason === right.sendUnavailableReason
    && left.activityStatus === right.activityStatus
    && JSON.stringify(left.suggestedOptions ?? null) === JSON.stringify(right.suggestedOptions ?? null)
    && left.suggestedPrompt === right.suggestedPrompt
    && left.capabilities?.canInterrupt === right.capabilities?.canInterrupt
    && left.capabilities?.canSend === right.capabilities?.canSend
    && left.external?.activeTurnId === right.external?.activeTurnId
    && left.external?.lastSettledTurnId === right.external?.lastSettledTurnId
    && left.external?.rawStatus === right.external?.rawStatus;
}

function projectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
