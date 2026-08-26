const TERMINAL_WORK_ITEM_STATUSES = new Set([
  "done", "complete", "completed", "canceled", "cancelled"
]);

export const MAX_AUTOMATIC_WORK_ITEM_SESSION_REPAIRS = 3;

export function historicalProviderSessionUnavailable(value) {
  return /no rollout found for thread id\b/i.test(String(value ?? ""));
}

export function evaluateWorkItemSessionRepair(input = {}) {
  const status = String(input.workItem?.status ?? "").trim().toLowerCase();
  if (!input.workItem?.id || TERMINAL_WORK_ITEM_STATUSES.has(status)) return denied("WORK_ITEM_TERMINAL");
  if (!input.session || input.session.sessionKind !== "worker"
    || input.workItem.current_session_id !== input.session.id) return denied("SESSION_NOT_CURRENT_WORKER");
  if (input.error?.code !== "PROVIDER_SESSION_UNAVAILABLE" || input.error.safeToRetry !== true) {
    return denied("PROVIDER_FAILURE_AMBIGUOUS");
  }
  if (input.failedWork?.targetTurnId || Number(input.turnCount ?? 0) > 0) {
    return denied("PROVIDER_EXECUTION_OBSERVED");
  }
  const uncertain = Array.isArray(input.uncertainDeliveries) ? input.uncertainDeliveries : [];
  if (uncertain.some((delivery) => delivery.status !== "delivery_unknown"
    || !historicalProviderSessionUnavailable(delivery.last_error))) {
    return denied("DELIVERY_OUTCOME_AMBIGUOUS");
  }
  if (Number(input.repairCount ?? 0) >= MAX_AUTOMATIC_WORK_ITEM_SESSION_REPAIRS) {
    return denied("REPAIR_LIMIT_REACHED");
  }
  if (!input.providerId || !input.agent) return denied("REPAIR_TARGET_UNAVAILABLE");
  return { eligible: true, reason: "provider-session-unavailable" };
}

function denied(reason) {
  return { eligible: false, reason };
}
