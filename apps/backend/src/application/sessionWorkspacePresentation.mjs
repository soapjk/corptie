import { applyWorkspaceContinuationPresentation } from "../utils/sessionPresentation.mjs";

export function createSessionWorkspacePresentation({ store }) {
  function sessionWithLogicalWorkspace(session, logical) {
    if (!session || !logical) return session;
    const worktree = logical.activeWorkspaceId
      ? store.getGitWorktree(logical.activeWorkspaceId)
      : null;
    const mainWorktree = logical.repositoryId
      ? store.listGitWorktrees(logical.repositoryId).find((candidate) => candidate.isMain)
      : null;
    const cwd = worktree?.canonicalPath || worktree?.path || logical.activeBinding?.boundCwd || session.external?.cwd;
    const latestTransition = store.getLatestCommittedWorkspaceTransition(logical.logicalSessionId);
    const pendingTransition = store.getPendingWorkspaceTransition(logical.logicalSessionId);
    const providerTransition = pendingTransition?.transitionKind === "provider" ? pendingTransition : null;
    const presented = applyWorkspaceContinuationPresentation(session, latestTransition);
    return {
      ...presented,
      sessionId: logical.legacySessionId ?? presented.id,
      logicalSessionId: logical.logicalSessionId,
      publicSessionId: logical.logicalSessionId,
      external: {
        ...(presented.external ?? {}),
        provider: logical.activeBinding?.providerId ?? presented.external?.provider,
        threadId: logical.activeThreadId,
        sessionId: logical.activeBinding?.providerSessionId ?? presented.external?.sessionId,
        cwd,
        logicalSessionId: logical.logicalSessionId,
        workspace: {
          id: logical.activeWorkspaceId,
          repositoryId: logical.repositoryId,
          projectPath: mainWorktree?.canonicalPath || mainWorktree?.path || null,
          path: cwd,
          availability: worktree?.availability ?? "available",
          branchName: worktree?.branchName ?? null,
          headOid: worktree?.headOid ?? null,
          transitionStrategy: latestTransition?.strategy ?? null,
          previousThreadId: latestTransition?.sourceThreadId ?? null,
          continuationState: latestTransition?.continuationState ?? null
        },
        routingVersion: logical.routingVersion,
        providerSwitchInFlight: Boolean(providerTransition),
        providerTransition: providerTransition
          ? {
              transitionId: providerTransition.transitionId,
              phase: providerTransition.phase,
              error: providerTransition.error?.message ?? null
            }
          : null
      }
    };
  }

  return { sessionWithLogicalWorkspace };
}

export function historicalDetailProjection(binding, detail) {
  if (!binding || binding.state === "active") return detail;
  const reason = "This is a read-only historical workspace thread.";
  return {
    ...detail,
    cwd: binding.boundCwd || detail.cwd,
    canSend: false,
    sendUnavailableReason: reason,
    readiness: "not_ready",
    notReadyReason: {
      code: "HISTORICAL_READ_ONLY",
      message: reason,
      retryable: false
    },
    capabilities: {
      ...(detail.capabilities ?? {}),
      canSend: false,
      canInterrupt: false
    },
    workspaceHistory: {
      logicalSessionId: binding.logicalSessionId,
      providerThreadId: binding.providerThreadId,
      worktreeId: binding.worktreeId,
      state: binding.state,
      readOnly: true
    },
    items: (detail.items ?? []).map((item) => item.type === "commandExecution"
      ? {
          ...item,
          title: `${item.title} · old workspace`,
          workspaceBoundary: "historical"
        }
      : item)
  };
}
