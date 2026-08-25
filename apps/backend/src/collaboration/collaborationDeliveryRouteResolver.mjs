export class CollaborationDeliveryRouteResolver {
  constructor({ core, ensureRecipientSession = null }) {
    if (!core) throw new TypeError("CollaborationDeliveryRouteResolver requires core.");
    this.core = core;
    this.ensureRecipientSession = ensureRecipientSession;
  }

  async resolve(envelope, { reason = "delivery_preflight" } = {}) {
    if (!envelope?.delivery?.deliveryId || !envelope?.task?.taskId) {
      throw routeError("COLLABORATION_ENVELOPE_INVALID", "Collaboration delivery envelope is incomplete.");
    }

    const direct = this.core.resolveDirectReplyRoute(envelope.delivery.deliveryId);
    if (direct) return presentDirectRoute(envelope, direct);

    if (this.ensureRecipientSession) {
      await this.ensureRecipientSession(envelope.task, { reason });
      envelope = this.core.getDeliveryEnvelope(envelope.delivery.deliveryId) ?? envelope;
      const recoveredDirect = this.core.resolveDirectReplyRoute(envelope.delivery.deliveryId);
      if (recoveredDirect) return presentDirectRoute(envelope, recoveredDirect);
    }

    const task = envelope.task;
    const logical = task.recipientSessionId
      ? (this.core.store.getLogicalSession(task.recipientSessionId)
        ?? this.core.store.getLogicalSessionByLegacySessionId(task.recipientSessionId))
      : null;
    if (!logical) {
      throw routeError(
        "RECIPIENT_SESSION_UNAVAILABLE",
        "Collaboration delivery requires an explicit logical recipient Session route."
      );
    }
    if (!logical.activeBinding) {
      throw routeError("STALE_RECIPIENT_ROUTE", `Recipient Session ${task.recipientSessionId} has no active Provider binding.`);
    }
    const providerSessionId = logical.legacySessionId;
    const stableSessionId = logical.logicalSessionId;
    if (!providerSessionId || !stableSessionId) {
      throw routeError("RECIPIENT_SESSION_UNAVAILABLE", "Recipient logical Session has no active resolvable Provider route.");
    }
    const bound = this.core.getAgentForSession(providerSessionId);
    if (!bound || bound.agentId !== task.recipientAgentId) {
      throw routeError(
        "RECIPIENT_SESSION_AGENT_MISMATCH",
        `Resolved Session ${stableSessionId} is not bound to recipient Agent ${task.recipientAgentId}.`
      );
    }
    return {
      task,
      sessionId: stableSessionId,
      providerSessionId,
      routingVersion: Number(logical.routingVersion ?? 0),
      bindingId: logical.activeBinding.bindingId ?? null,
      created: false,
      mode: "task_route",
      channelId: null
    };
  }

  assertCurrent(envelope, route) {
    if (!route) throw routeError("RECIPIENT_SESSION_UNAVAILABLE", "Resolved collaboration route is missing.");
    if (route.mode === "channel" || route.mode === "fallback") {
      const current = this.core.resolveDirectReplyRoute(envelope.delivery.deliveryId);
      if (!current
          || current.sessionId !== route.sessionId
          || current.providerSessionId !== route.providerSessionId
          || current.mode !== route.mode) {
        throw routeError("COLLABORATION_ROUTE_CHANGED", "Collaboration channel route changed before delivery execution.");
      }
      return route;
    }
    const currentEnvelope = this.core.getDeliveryEnvelope(envelope.delivery.deliveryId);
    const task = currentEnvelope?.task;
    const logical = task?.recipientSessionId
      ? (this.core.store.getLogicalSession(task.recipientSessionId)
        ?? this.core.store.getLogicalSessionByLegacySessionId(task.recipientSessionId))
      : null;
    const bound = logical?.legacySessionId
      ? this.core.getAgentForSession(logical.legacySessionId)
      : null;
    if (!logical?.activeBinding
        || logical.logicalSessionId !== route.sessionId
        || logical.legacySessionId !== route.providerSessionId
        || Number(logical.routingVersion ?? 0) !== Number(route.routingVersion ?? 0)
        || logical.activeBinding.bindingId !== route.bindingId
        || bound?.agentId !== task.recipientAgentId) {
      throw routeError("COLLABORATION_ROUTE_CHANGED", "Collaboration recipient route changed before delivery execution.");
    }
    return route;
  }
}

function presentDirectRoute(envelope, direct) {
  return {
    task: envelope.task,
    sessionId: direct.sessionId,
    providerSessionId: direct.providerSessionId,
    routingVersion: null,
    bindingId: null,
    created: false,
    mode: direct.mode,
    channelId: direct.channel?.channelId ?? null,
    channel: direct.channel ?? null
  };
}

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
