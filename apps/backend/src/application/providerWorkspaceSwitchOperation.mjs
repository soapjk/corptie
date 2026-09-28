export async function switchProviderWorkspaceRoute(reference, input, {
  resolveLogical,
  checkpointFor,
  transitionManager,
  collaborationOptionsFor = async () => ({}),
  emitEvent,
  missingRouteMessage
}) {
  const logical = await resolveLogical(reference);
  if (!logical) throw new Error(missingRouteMessage);
  const sessionId = reference.sessionId;
  const checkpoint = checkpointFor(sessionId, logical.activeBinding?.bindingId);
  const result = await transitionManager.switchWorkspace({
    transitionId: input.transitionId,
    logicalSessionId: logical.logicalSessionId,
    targetWorktreeId: input.targetWorkspaceId,
    activeTurnId: checkpoint.activeTurnId,
    lastCompletedTurnId: checkpoint.lastCompletedTurnId,
    continuationPrompt: input.continuationPrompt,
    ...await collaborationOptionsFor(sessionId)
  });
  emitEvent(
    result.status === "waitingForTurn"
      ? "SessionWorkspaceSwitchWaiting"
      : "SessionWorkspaceSwitchCompleted",
    { sessionId, logicalSessionId: logical.logicalSessionId, transition: result.transition },
    { sessionId }
  );
  return result;
}

export function createProviderWorkspaceSwitches({
  store, ensureLogicalRouteForCodexSession, sessionTransitionCheckpoint,
  workspaceTransitionManager, claudeWorkspaceTransitionManager,
  openClackyWorkspaceTransitionManager,
  collaborationThreadOptionsForSession, emitEvent
}) {
  function resolveBoundLogical(reference) {
    const logical = (reference.logicalSessionId
      ? store.getLogicalSession(reference.logicalSessionId)
      : null) ?? store.getLogicalSessionByLegacySessionId(reference.sessionId);
    return logical?.activeBinding ? logical : null;
  }

  async function switchCodexProviderWorkspace(reference, input = {}) {
    return switchProviderWorkspaceRoute(reference, input, {
      resolveLogical: async (currentReference) => {
        const session = currentReference.metadata?.session ?? store.getSession(currentReference.sessionId);
        if (!session) throw new Error("Session not found.");
        return (currentReference.logicalSessionId
          ? store.getLogicalSession(currentReference.logicalSessionId)
          : null) ?? ensureLogicalRouteForCodexSession(session);
      },
      checkpointFor: sessionTransitionCheckpoint,
      transitionManager: workspaceTransitionManager,
      collaborationOptionsFor: collaborationThreadOptionsForSession,
      emitEvent,
      missingRouteMessage: "Session has no active workspace route."
    });
  }

  async function switchClaudeProviderWorkspace(reference, input = {}) {
    return switchProviderWorkspaceRoute(reference, input, {
      resolveLogical: resolveBoundLogical,
      checkpointFor: sessionTransitionCheckpoint,
      transitionManager: claudeWorkspaceTransitionManager,
      emitEvent,
      missingRouteMessage: "Claude Session has no active workspace route."
    });
  }

  async function switchOpenClackyProviderWorkspace(reference, input = {}) {
    return switchProviderWorkspaceRoute(reference, input, {
      resolveLogical: resolveBoundLogical,
      checkpointFor: sessionTransitionCheckpoint,
      transitionManager: openClackyWorkspaceTransitionManager,
      emitEvent,
      missingRouteMessage: "OpenClacky Session has no active workspace route."
    });
  }

  return {
    switchCodexProviderWorkspace,
    switchClaudeProviderWorkspace,
    switchOpenClackyProviderWorkspace
  };
}
