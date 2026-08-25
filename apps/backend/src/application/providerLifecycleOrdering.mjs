const TERMINAL_STATUSES = new Set(["complete", "completed", "failed", "cancelled"]);

/// Provider callbacks can be duplicated or reordered across reconnects. The
/// normalized timeline is always safe to reconcile by stable item id, but an
/// old item/turn callback must not move durable Session metadata backwards.
export function providerLifecycleMetadataDecision({ eventName, eventTurnId, session }) {
  const turnId = optionalText(eventTurnId);
  const activeTurnId = optionalText(session?.external?.activeTurnId);
  const lastSettledTurnId = optionalText(session?.external?.lastSettledTurnId);
  const terminal = TERMINAL_STATUSES.has(session?.status);

  if (eventName === "item/started" || eventName === "item/completed") {
    if (turnId && lastSettledTurnId === turnId) return stale("settled_turn_item");
    if (turnId && activeTurnId && activeTurnId !== turnId) return stale("non_active_turn_item");
    if (terminal && !activeTurnId) return stale("terminal_session_item");
    return apply();
  }

  if (eventName === "turn/completed") {
    if (turnId && activeTurnId && activeTurnId !== turnId) return stale("non_active_turn_completion");
    if (turnId && lastSettledTurnId === turnId && terminal) return stale("duplicate_turn_completion");
    if (terminal && !activeTurnId) return stale("terminal_session_completion");
  }
  return apply();
}

function apply() {
  return { applyMetadata: true, reason: null };
}

function stale(reason) {
  return { applyMetadata: false, reason };
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
