import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";

// Post-turn orchestration keeps workspace and Provider transitions distinct.
// Failures are published without escaping asynchronous lifecycle callbacks.
export function createPostTurnWorkspaceOperations({
  store, workspaceTransitionRuntimeForLogicalSession, sessionBindingRepository,
  sessionProviderSwitchCoordinator, workspaceContinuationCoordinator,
  createGitWorkspaceSnapshot, emitEvent
}) {
  const reconcilingWorkspacePaths = new Set();
  function continuePendingWorkspaceTransition(logical, lastCompletedTurnId) {
    const transition = logical
      ? store.getPendingWorkspaceTransition(logical.logicalSessionId)
      : null;
    if (!transition || transition.phase !== "waitingForTurn") return null;
    if (transition.transitionKind === "provider") return null;
    return workspaceTransitionRuntimeForLogicalSession(logical).then(({ manager, options }) => (
      manager.continueWorkspaceTransition(transition.transitionId, {
        lastCompletedTurnId,
        ...options
      })
    )).catch((error) => {
      console.error(`[workspace-transition] failed transition=${transition.transitionId} error=${error.message}`);
      emitEvent("SessionWorkspaceSwitchFailed", {
        logicalSessionId: logical.logicalSessionId,
        sessionId: logical.legacySessionId,
        transitionId: transition.transitionId,
        error: error.message
      }, { sessionId: logical.legacySessionId });
    });
  }

  function continuePendingProviderSwitch(logical) {
    const transition = logical
      ? store.getPendingWorkspaceTransition(logical.logicalSessionId)
      : null;
    if (!transition || transition.phase !== "waitingForTurn") return null;
    if (transition.transitionKind !== "provider") return null;
    const reference = sessionBindingRepository.resolve(logical.legacySessionId ?? logical.logicalSessionId);
    return sessionProviderSwitchCoordinator.completeProviderSwitch(
      transition.transitionId,
      undefined,
      reference,
      logical
    ).catch((error) => {
      console.error(`[provider-switch] failed transition=${transition.transitionId} error=${error.message}`);
      emitEvent("ProviderSwitchFailed", {
        logicalSessionId: logical.logicalSessionId,
        sessionId: logical.legacySessionId,
        transitionId: transition.transitionId,
        error: error.message
      }, { sessionId: logical.legacySessionId });
    });
  }

  function enqueueWorkspaceContinuationSafely(transitionId) {
    try {
      return workspaceContinuationCoordinator.enqueueForTransition(transitionId);
    } catch (error) {
      console.error(`[workspace-continuation] deferred transition=${transitionId} error=${error.message}`);
      emitEvent("WorkspaceContinuationDeferred", {
        transitionId,
        error: error.message
      }, { source: { type: "workspace-continuation" } });
      return null;
    }
  }

  function refreshWorkspaceInventoryAfterTurn(logical) {
    if (!logical?.repositoryId || !logical.activeBinding?.boundCwd) return;
    const previousWorktrees = store.listGitWorktrees(logical.repositoryId);
    const previousWorktreeIds = new Set(previousWorktrees.map((worktree) => worktree.worktreeId));
    const previousVersion = logical.activeWorkspaceId
      ? store.getGitWorktree(logical.activeWorkspaceId)?.inventoryVersion
      : null;
    createGitWorkspaceSnapshot(logical.activeBinding.boundCwd)
      .then(async (snapshot) => {
        store.upsertGitWorkspaceSnapshot(snapshot);
        await reconcileMovedWorkspaceRoutes(snapshot.worktrees);
        if (snapshot.inventoryVersion === previousVersion) return;
        emitEvent("WorkspaceInventoryChanged", {
          sessionId: logical.legacySessionId,
          logicalSessionId: logical.logicalSessionId,
          repositoryId: logical.repositoryId,
          inventoryVersion: snapshot.inventoryVersion,
          workspaces: store.listGitWorktrees(logical.repositoryId),
          newlyDiscoveredWorkspaces: snapshot.worktrees.filter((worktree) => {
            return !previousWorktreeIds.has(worktree.worktreeId);
          })
        }, { sessionId: logical.legacySessionId });
      })
      .catch((error) => {
        console.warn(`[workspace-inventory] refresh failed logicalSession=${logical.logicalSessionId} error=${error.message}`);
      });
  }

  async function reconcileMovedWorkspaceRoutes(worktrees = [], options = {}) {
    for (const worktree of worktrees) {
      if (worktree.availability !== "available") continue;
      for (const logical of store.listLogicalSessionsByWorkspaceId(worktree.worktreeId)) {
        const targetCwd = worktree.canonicalPath || worktree.path;
        if (!targetCwd || logical.activeBinding?.boundCwd === targetCwd) continue;
        if (reconcilingWorkspacePaths.has(logical.logicalSessionId)) continue;
        const session = logical.legacySessionId ? store.getSession(logical.legacySessionId) : null;
        if (sessionHasActiveRun(session)) {
          emitEvent("SessionWorkspacePathRebindDeferred", {
            sessionId: logical.legacySessionId,
            logicalSessionId: logical.logicalSessionId,
            providerThreadId: logical.activeThreadId,
            worktreeId: logical.activeWorkspaceId,
            previousCwd: logical.activeBinding?.boundCwd,
            cwd: targetCwd,
            reason: "activeTurn"
          }, { sessionId: logical.legacySessionId });
          continue;
        }
        if (options.verifyProviderIdle) {
          const unsettled = logical.legacySessionId
            ? store.listUnsettledSessionTurns(logical.legacySessionId)
            : [];
          if (unsettled.length > 0) continue;
        }
        reconcilingWorkspacePaths.add(logical.logicalSessionId);
        try {
          const runtime = await workspaceTransitionRuntimeForLogicalSession(logical);
          await runtime.manager.reconcileActiveWorkspacePath(
            logical.logicalSessionId,
            runtime.options
          );
        } catch (error) {
          console.warn(`[workspace-route] path rebind failed logicalSession=${logical.logicalSessionId} error=${error.message}`);
          emitEvent("SessionWorkspacePathRebindFailed", {
            sessionId: logical.legacySessionId,
            logicalSessionId: logical.logicalSessionId,
            providerThreadId: logical.activeThreadId,
            worktreeId: logical.activeWorkspaceId,
            previousCwd: logical.activeBinding?.boundCwd,
            cwd: targetCwd,
            error: error.message
          }, { sessionId: logical.legacySessionId });
        } finally {
          reconcilingWorkspacePaths.delete(logical.logicalSessionId);
        }
      }
    }
  }

  return {
    continuePendingWorkspaceTransition, continuePendingProviderSwitch,
    enqueueWorkspaceContinuationSafely, refreshWorkspaceInventoryAfterTurn, reconcileMovedWorkspaceRoutes
  };
}
