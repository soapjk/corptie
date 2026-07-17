import { formatTrustedCollaborationEvent } from "./trustedCollaborationEvent.mjs";

export class CollaborationDeliveryDispatcher {
  constructor(options) {
    this.core = options.core;
    this.runtime = options.runtime;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.intervalMs = options.intervalMs ?? 2000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 2000;
    this.onEvent = options.onEvent ?? (() => {});
    this.timer = null;
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    const recovered = this.core.recoverInterruptedDeliveries();
    if (recovered > 0) this.onEvent("CollaborationDeliveriesRecovered", { count: recovered });
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.onEvent("CollaborationDeliveryDispatcherError", { error: error.message }));
    }, this.intervalMs);
    this.timer.unref?.();
    this.tick().catch((error) => this.onEvent("CollaborationDeliveryDispatcherError", { error: error.message }));
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const deliveries = this.core.listPendingDeliveries(100, this.maxAttempts);
      for (const delivery of deliveries) await this.dispatch(delivery.deliveryId);
      const queued = this.core.listQueuedDeliveries(100);
      for (const delivery of queued) await this.dispatch(delivery.deliveryId);
    } finally {
      this.ticking = false;
    }
  }

  async drainSession(sessionId) {
    const agent = this.core.getAgentForSession(sessionId);
    if (!agent) return;
    const deliveries = this.core.listQueuedDeliveriesForAgent(agent.agentId);
    for (const delivery of deliveries) {
      await this.dispatch(delivery.deliveryId);
      const state = await this.runtime.inspect(sessionId);
      if (state === "running") break;
    }
  }

  async dispatch(deliveryId) {
    const envelope = this.core.getDeliveryEnvelope(deliveryId);
    if (!envelope || envelope.delivery.status === "delivered") return envelope?.delivery ?? null;
    const agent = this.core.getAgent(envelope.delivery.recipientAgentId);
    const sessionId = agent?.currentSessionId ?? null;
    if (!sessionId) {
      return this.#fail(envelope, "Recipient Agent has no current Session.", "recipient_unavailable");
    }

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
        nextAttemptAt: null,
        lastError: null
      });
      this.core.recordDeliveryEvent(deliveryId, "delivery_succeeded", {
        sessionId,
        targetTurnId: delivered.targetTurnId,
        attemptCount: delivered.attemptCount
      });
      this.onEvent("CollaborationDeliverySucceeded", { delivery: delivered, sessionId });
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
