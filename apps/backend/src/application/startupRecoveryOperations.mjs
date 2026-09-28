// Resume only persisted operations. This module never invents a recovery request.
export function createStartupRecoveryOperations({
  store, sessionApplicationService, sessionRecoveryCoordinator,
  sessionBindingRepository, sessionProviderSwitchCoordinator,
  workspaceTransitionRuntimeForLogicalSession, logger = console
}) {
  async function deleteHistoricalUnusableTaskSessionsAtStartup() {
    let deleted = 0;
    for (const sessionId of store.listUnusableReplacedTaskSessionIds()) {
      const result = await sessionApplicationService.deleteUnusableSession(sessionId, {
        source: "task-self-repair-startup-cleanup"
      });
      if (result.deleted) deleted += 1;
      if (!result.providerDeleted) {
        logger.warn(`[task-self-repair] startup removed unusable local Session after Provider deletion failed previousSession=${sessionId} code=${result.providerErrorCode ?? "unknown"}`);
      }
    }
    return deleted;
  }

  async function resumeSessionRecoveryAttemptsAtStartup() {
    const resumable = store.listResumableSessionRecoveryAttempts();
    const legacyAutomatic = resumable.filter((attempt) =>
      attempt.idempotencyKey.startsWith("startup-empty-binding-recovery:")
    );
    for (const attempt of legacyAutomatic) {
      store.failSessionRecoveryAttempt(
        attempt.attemptId,
        "LEGACY_AUTOMATIC_RECOVERY_DISABLED",
        "Legacy automatic empty-binding Recovery was disabled; explicit user Recovery is required."
      );
    }
    const attempts = resumable.filter((attempt) =>
      !attempt.idempotencyKey.startsWith("startup-empty-binding-recovery:")
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < attempts.length) {
        const attempt = attempts[cursor];
        cursor += 1;
        try {
          await sessionRecoveryCoordinator.recover({
            logicalSessionId: attempt.logicalSessionId,
            providerId: attempt.providerId,
            idempotencyKey: attempt.idempotencyKey,
            attemptId: attempt.attemptId,
            compressHandoff: true
          });
        } catch (error) {
          logger.warn(`[session-recovery] startup resume failed attempt=${attempt.attemptId} code=${error.code ?? "SESSION_RECOVERY_FAILED"}`);
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(2, attempts.length) },
      () => worker()
    ));
  }

  async function recoverPendingWorkspaceTransitions() {
    for (const transition of store.listPendingWorkspaceTransitions()) {
      const logical = store.getLogicalSession(transition.logicalSessionId);
      try {
        if (transition.transitionKind === "provider") {
          const sessionId = logical?.legacySessionId;
          const unsettled = sessionId ? store.listUnsettledSessionTurns(sessionId) : [];
          if (unsettled.length > 0) {
            logger.log(`[provider-switch] recovery waiting transition=${transition.transitionId} unsettled=${unsettled.length}`);
            continue;
          }
          const reference = sessionBindingRepository.resolve(
            logical?.legacySessionId ?? logical?.logicalSessionId
          );
          const recovered = await sessionProviderSwitchCoordinator.completeProviderSwitch(
            transition.transitionId,
            undefined,
            reference,
            logical
          );
          logger.log(`[provider-switch] recovered transition=${transition.transitionId} status=${recovered.status}`);
          continue;
        }
        const runtime = await workspaceTransitionRuntimeForLogicalSession(logical);
        const recovered = await runtime.manager.recoverWorkspaceTransition(
          transition.transitionId,
          runtime.options
        );
        logger.log(`[workspace-transition] recovered transition=${transition.transitionId} status=${recovered.status}`);
      } catch (error) {
        logger.warn(`[workspace-transition] recovery failed transition=${transition.transitionId} error=${error.message}`);
      }
    }
  }

  return {
    deleteHistoricalUnusableTaskSessionsAtStartup,
    resumeSessionRecoveryAttemptsAtStartup,
    recoverPendingWorkspaceTransitions
  };
}
