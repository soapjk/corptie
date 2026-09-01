const TERMINAL_TASK_LIFECYCLE_STATES = new Set([
  "done"
]);

// Keep recovery bounded while leaving one upgrade-time attempt for legacy
// replacement chains that were themselves created by the empty-thread bug.
export const MAX_AUTOMATIC_TASK_SESSION_REPAIRS = 4;

export function historicalProviderSessionUnavailable(value) {
  return /(?:no rollout found for thread id\b|failed to resolve rollout path\b.*\bfile does not exist)/i
    .test(String(value ?? ""));
}

export function historicalTaskBindingUnavailable(value) {
  return /^Task\s+\S+\s+points to no Session, not active Worker Session\s+\S+\.?$/i
    .test(String(value ?? "").trim());
}

export function historicalPreExecutionSessionFailure(value) {
  return historicalProviderSessionUnavailable(value)
    || historicalTaskBindingUnavailable(value);
}

export function evaluateTaskSessionRepair(input = {}) {
  const status = String(input.task?.lifecycle_state ?? "").trim().toLowerCase();
  if (!input.task?.id || TERMINAL_TASK_LIFECYCLE_STATES.has(status)) return denied("TASK_TERMINAL");
  if (!input.session || input.session.sessionKind !== "worker"
    || input.task.current_session_id !== input.session.id) return denied("SESSION_NOT_CURRENT_WORKER");
  if (input.error?.code !== "PROVIDER_SESSION_UNAVAILABLE" || input.error.safeToRetry !== true) {
    return denied("PROVIDER_FAILURE_AMBIGUOUS");
  }
  if (input.failedWork?.targetTurnId || Number(input.turnCount ?? 0) > 0) {
    return denied("PROVIDER_EXECUTION_OBSERVED");
  }
  const uncertain = Array.isArray(input.uncertainDeliveries) ? input.uncertainDeliveries : [];
  if (uncertain.some((delivery) => delivery.status !== "delivery_unknown"
    || !historicalPreExecutionSessionFailure(delivery.last_error))) {
    return denied("DELIVERY_OUTCOME_AMBIGUOUS");
  }
  if (Number(input.repairCount ?? 0) >= MAX_AUTOMATIC_TASK_SESSION_REPAIRS) {
    return denied("REPAIR_LIMIT_REACHED");
  }
  if (!input.providerId || !input.agent) return denied("REPAIR_TARGET_UNAVAILABLE");
  return { eligible: true, reason: "provider-session-unavailable" };
}

function denied(reason) {
  return { eligible: false, reason };
}
