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
  "approval.resolved"
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
      ? this.store.getAgentWorkItemForTurn?.(sessionId, event.turnId)
        ?? this.store.claimRunningAgentWorkItemForProviderTurn?.(sessionId, event.turnId)
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
      timelineChanged = this.persistItem(
        sessionId,
        event.payload.item,
        event.bindingId,
        correlatedDelivery,
        correlatedWork
      ) || timelineChanged;
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
    }
    const projectedTurnItems = event.turnId
      ? this.store.getItemsForTurn?.(sessionId, event.turnId, session.external?.provider) ?? []
      : [];
    const finalAgentMessage = event.type === "turn.completed"
      ? finalItemForTurn({ items: projectedTurnItems }, event.turnId)
      : null;
    const terminalOutcome = providerTerminalOutcome(event, projectedTurnItems);

    const turnStatus = projectedTurnStatus(event, terminalOutcome);
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

  persistItem(sessionId, item, bindingId, delivery = null, workItem = null) {
    if (!item?.id) return false;
    let canonicalItem = item;
    if (item.type === "userMessage" && delivery) {
      canonicalItem = {
        ...item,
        id: delivery.messageId,
        turnId: delivery.providerTurnId ?? item.turnId,
        status: delivery.status
      };
    } else if (item.type === "userMessage" && workItem) {
      const canonicalId = workItem.kind === "user"
        ? (workItem.source?.messageId ?? workItem.workItemId)
        : `work:${workItem.workItemId}`;
      const existing = this.store.getSessionItem?.(sessionId, canonicalId);
      canonicalItem = {
        ...item,
        id: canonicalId,
        turnId: workItem.targetTurnId ?? item.turnId,
        title: existing?.title ?? item.title,
        status: workItem.status,
        presentationRole: existing?.presentationRole ?? item.presentationRole,
        presentationText: existing?.presentationText ?? item.presentationText,
        rawMetadataJSON: mergedItemMetadata(existing?.rawMetadataJSON, item.rawMetadataJSON, {
          workItemId: workItem.workItemId,
          sourceChannel: workItem.source?.type ?? null,
          collaborationTaskId: workItem.source?.taskId ?? null
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
      ? "Waiting for approval"
      : status === "running"
        ? activityForEvent(event)
        : null;
    const activeTurn = unsettled.findLast?.((turn) => turn.binding_id === binding.bindingId)
      ?? unsettled.at(-1)
      ?? null;
    const providerFailure = event.type === "provider.error" && event.payload?.willRetry !== true
      ? normalizeProviderFailure(event.payload?.error)
      : null;
    const next = {
      ...session,
      status,
      progress: status === "running" || status === "blocked" ? 0.5 : 1,
      summary: latestAgentItem?.text || providerFailure?.message || session.summary,
      sendUnavailableReason: providerFailure?.message ?? session.sendUnavailableReason ?? null,
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
        ...(providerFailure ? { canSend: false } : {}),
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
  if (event.type === "approval.requested") return "blocked";
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

function providerTerminalOutcome(event, projectedTurnItems = []) {
  const status = TERMINAL_EVENT_STATUS.get(event.type);
  if (!status) return null;
  if (status !== "completed") {
    return {
      status,
      failure: status === "failed" ? normalizeProviderFailure(event.payload?.error) : null
    };
  }
  const items = projectedTurnItems.length > 0 ? projectedTurnItems : (event.payload?.items ?? []);
  if (finalItemForTurn({ items }, event.turnId)) return { status, failure: null };
  if (collaborationConfirmationHandoffForTurn(items, event.turnId)) {
    return { status, failure: null };
  }
  const failedItem = [...items].reverse().find((item) =>
    (!event.turnId || item?.turnId === event.turnId)
    && item?.status === "failed"
    && !["userMessage", "agentMessage", "reasoning"].includes(item?.type)
  );
  if (!failedItem) return { status, failure: null };
  return {
    status: "failed",
    failure: {
      code: "PROVIDER_TOOL_FAILED_WITHOUT_FINAL_RESPONSE",
      message: `${failedItem.title || "Provider tool"} failed and the Provider ended the turn without a final response.`,
      itemId: failedItem.id ?? null
    }
  };
}

function collaborationConfirmationHandoffForTurn(items, turnId) {
  return items.some((item) =>
    (!turnId || item?.turnId === turnId)
    && item?.type === "collaborationConfirmation"
    && item?.presentationRole === "collaboration_confirmation"
    && ["pending", "confirmed", "rejected"].includes(item?.status)
  );
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
