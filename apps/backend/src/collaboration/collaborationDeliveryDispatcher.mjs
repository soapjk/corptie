import { formatTrustedCollaborationEvent } from "./trustedCollaborationEvent.mjs";
import { CollaborationDeliveryRouteResolver } from "./collaborationDeliveryRouteResolver.mjs";

export class CollaborationDeliveryDispatcher {
  constructor(options) {
    this.core = options.core;
    this.runtime = options.runtime;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 2000;
    this.onEvent = options.onEvent ?? (() => {});
    this.ensureRecipientSession = options.ensureRecipientSession ?? null;
    this.routeResolver = options.routeResolver ?? new CollaborationDeliveryRouteResolver({
      core: this.core,
      ensureRecipientSession: this.ensureRecipientSession
    });
  }

  async dispatch(deliveryId, { resolvedRoute = null } = {}) {
    let envelope = this.core.getDeliveryEnvelope(deliveryId);
    if (!envelope || envelope.delivery.status === "delivered") return envelope?.delivery ?? null;
    let route = resolvedRoute;
    if (!route) {
      try {
        route = await this.routeResolver.resolve(envelope, { reason: "delivery_preflight" });
        envelope = this.core.getDeliveryEnvelope(deliveryId) ?? envelope;
      } catch (error) {
        return this.failRoute(deliveryId, error, { envelope });
      }
    } else {
      try {
        route = this.routeResolver.assertCurrent(envelope, route);
      } catch (error) {
        return this.failRoute(deliveryId, error, { envelope, eventType: "execution_route_changed" });
      }
    }
    const sessionId = route.providerSessionId;

    let state;
    try {
      state = await this.runtime.inspect(sessionId);
    } catch (error) {
      return this.#fail(envelope, `Could not inspect target Session: ${error.message}`, "session_inspection_failed");
    }
    if (state === "running") {
      if (envelope.delivery.status === "queued") return envelope.delivery;
      const queued = this.core.updateDelivery(deliveryId, { status: "queued", nextAttemptAt: null, lastError: null });
      this.core.recordDeliveryEvent(deliveryId, "delivery_queued", { sessionId, reason: "session_running" });
      this.onEvent("CollaborationDeliveryQueued", { delivery: queued, sessionId });
      return queued;
    }
    if (state === "missing") {
      return this.#fail(envelope, `Target Session ${sessionId} is unavailable.`, "session_missing");
    }
    if (!this.core.claimDelivery(deliveryId)) return this.core.getDelivery(deliveryId);

    try {
      if (state === "stopped") await this.runtime.resume(sessionId);
      const result = await this.runtime.startTurn(sessionId, formatTrustedCollaborationEvent(envelope), {
        deliveryId,
        messageId: envelope.message.messageId,
        taskId: envelope.task.taskId
      });
      const delivered = this.core.updateDelivery(deliveryId, {
        status: "delivered",
        deliveredAt: this.clock(),
        targetTurnId: result?.turnId ?? result?.turn?.id ?? null,
        targetSessionId: route.sessionId,
        nextAttemptAt: null,
        lastError: null
      });
      this.core.recordDeliveryEvent(deliveryId, "delivery_succeeded", {
        sessionId,
        targetTurnId: delivered.targetTurnId,
        attemptCount: delivered.attemptCount
      });
      this.onEvent("CollaborationDeliverySucceeded", { delivery: delivered, sessionId });
      if (route.mode === "channel" || route.mode === "fallback") {
        this.onEvent("CollaborationChannelDeliverySucceeded", {
          channelId: route.channelId,
          taskId: envelope.task.taskId,
          deliveryId,
          senderSessionId: envelope.message.envelope.sender.sessionId,
          recipientSessionId: route.sessionId,
          routeMode: route.mode
        });
      }
      return delivered;
    } catch (error) {
      if (error.code === "SESSION_BUSY") {
        const queued = this.core.updateDelivery(deliveryId, {
          status: "queued",
          nextAttemptAt: null,
          lastError: null
        });
        this.core.recordDeliveryEvent(deliveryId, "delivery_queued", { sessionId, reason: "session_became_busy" });
        this.onEvent("CollaborationDeliveryQueued", { delivery: queued, sessionId });
        return queued;
      }
      return this.#fail(this.core.getDeliveryEnvelope(deliveryId) ?? envelope, error.message, "delivery_failed", false);
    }
  }

  failRoute(deliveryId, error, { envelope = null, eventType = "delivery_route_failed" } = {}) {
    const currentEnvelope = envelope ?? this.core.getDeliveryEnvelope(deliveryId);
    const code = error?.code ?? "RECIPIENT_ROUTE_FAILED";
    const message = error?.message ?? String(error);
    this.onEvent("CollaborationDeliveryRouteFailed", {
      deliveryId,
      taskId: currentEnvelope?.task?.taskId ?? null,
      sessionId: currentEnvelope?.task?.recipientSessionId ?? null,
      code,
      error: message
    });
    if (!currentEnvelope) return this.#failOrphanedDelivery(deliveryId, message, eventType);
    return this.#fail(currentEnvelope, message, eventType);
  }

  #failOrphanedDelivery(deliveryId, message, eventType) {
    const delivery = this.core.getDelivery(deliveryId);
    if (!delivery) return null;
    const attempts = delivery.attemptCount + 1;
    const exhausted = attempts >= this.maxAttempts;
    const failed = this.core.updateDelivery(deliveryId, {
      status: "failed",
      incrementAttempt: true,
      nextAttemptAt: exhausted
        ? null
        : new Date(Date.parse(this.clock()) + this.retryBaseMs * (2 ** Math.max(0, attempts - 1))).toISOString(),
      lastError: message
    });
    this.onEvent(exhausted ? "CollaborationDeliveryExhausted" : "CollaborationDeliveryRetryScheduled", {
      delivery: failed,
      eventType,
      orphanedEnvelope: true
    });
    return failed;
  }

  #fail(envelope, message, eventType, incrementAttempt = true) {
    const attempts = envelope.delivery.attemptCount + (incrementAttempt ? 1 : 0);
    const exhausted = attempts >= this.maxAttempts;
    const nextAttemptAt = exhausted ? null : new Date(Date.parse(this.clock()) + this.retryBaseMs * (2 ** Math.max(0, attempts - 1))).toISOString();
    const failed = this.core.updateDelivery(envelope.delivery.deliveryId, {
      status: "failed",
      incrementAttempt,
      nextAttemptAt,
      lastError: message
    });
    this.core.recordDeliveryEvent(envelope.delivery.deliveryId, exhausted ? "delivery_exhausted" : eventType, {
      error: message,
      attemptCount: failed.attemptCount,
      nextAttemptAt
    });
    this.onEvent(exhausted ? "CollaborationDeliveryExhausted" : "CollaborationDeliveryFailed", { delivery: failed });
    return failed;
  }
}
