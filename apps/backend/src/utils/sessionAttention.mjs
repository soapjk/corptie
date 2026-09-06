// Provider-neutral, bounded control-plane projection. Never interpret prose
// or a generic `blocked` state as a particular approval/question.
export function sessionAttention({ status, executionStatus, choice, failureReason, updatedAt }) {
  const state = executionStatus ?? status;
  if (choice?.status === "active" && choice.options?.length >= 2
      && ["blocked", "idle", "completed", "complete"].includes(state)) {
    return { kind: "choice", reason: choice.prompt || null,
      sourceId: choice.id ?? null, updatedAt: choice.createdAt ?? updatedAt };
  }
  if (state === "failed") {
    return { kind: "failed", reason: failureReason || null, sourceId: null, updatedAt };
  }
  if (state === "blocked") {
    return { kind: "blocked", reason: null, sourceId: null, updatedAt };
  }
  return null;
}
