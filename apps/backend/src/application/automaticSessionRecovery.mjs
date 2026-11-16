// Only adapter-confirmed absence permits replacement. Timeouts and account
// failures must never be interpreted as a missing conversation.
export function isMissingProviderSession(error) {
  return error?.code === "PROVIDER_SESSION_UNAVAILABLE" && (
    error.safeToRetry === true || error.replacementReason === "provider-session-not-found"
  ) || error?.code === "PROVIDER_EMPTY_THREAD_UNRECOVERABLE" && error.safeToRecreate === true;
}

export function createAutomaticSessionRecovery({ recover, resolveReference, clock = Date.now }) {
  const failures = new Map();
  return async ({ reference, error, triggerDeliveryId = null }) => {
    if (!isMissingProviderSession(error) || !reference.logicalSessionId || !reference.bindingId) throw error;
    const current = await resolveReference(reference.sessionId);
    if (current.bindingId !== reference.bindingId) return current;
    const key = `missing-thread-recovery:${reference.bindingId}`;
    const previous = failures.get(key);
    if (previous && clock() < previous.retryAt) throw previous.error;
    try {
      const result = await recover({ logicalSessionId: reference.logicalSessionId,
        providerId: reference.providerId, idempotencyKey: key, triggerDeliveryId,
        reason: error.code });
      if (result.state !== "committed") throw Object.assign(new Error("会话恢复尚未完成；历史记录已保留。"), {
        code: result.errorCode ?? "SESSION_RECOVERY_INCOMPLETE"
      });
      failures.delete(key);
      return await resolveReference(reference.sessionId);
    } catch (cause) {
      if (failures.size >= 256) failures.delete(failures.keys().next().value);
      failures.set(key, { error: cause, retryAt: clock() + 30000 });
      throw cause;
    }
  };
}
