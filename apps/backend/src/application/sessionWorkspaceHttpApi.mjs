import { storedSessionDetail } from "./storedSessionDetail.mjs";

export function handleSessionWorkspaceHttpRequest({
  request, response, url, store, sessionApplicationService, requireSessionReference,
  ensureLogicalRouteForProviderSession, createGitWorkspaceSnapshot, reconcileMovedWorkspaceRoutes,
  sessionWorkspaceRecoveryStatus, switchSessionWorkspace, recoverableAgentWorkDir, ensureAgentWorkDir,
  gitWorkspaces, switchSessionProvider, decorateSessionForClient,
  readJson, sendJson, emitEvent, errorStatus, unifiedErrorStatus
}) {
  const sessionWorkspacesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/workspaces$/);
  if (request.method === "GET" && sessionWorkspacesMatch) {
    const sessionId = decodeURIComponent(sessionWorkspacesMatch[1]);
    Promise.resolve()
      .then(async () => {
        const reference = await sessionApplicationService.referenceFor(sessionId);
        const session = reference.metadata.session;
        let logical = reference.logicalSessionId
          ? store.getLogicalSession(reference.logicalSessionId)
          : await ensureLogicalRouteForProviderSession(session, reference.providerId);
        if (!logical) {
          const error = new Error("Session workspace route not found.");
          error.code = "SESSION_NOT_FOUND";
          throw error;
        }
        if (logical.activeBinding?.boundCwd) {
          try {
            const snapshot = await createGitWorkspaceSnapshot(logical.activeBinding.boundCwd);
            store.upsertGitWorkspaceSnapshot(snapshot);
            await reconcileMovedWorkspaceRoutes(snapshot.worktrees);
            logical = store.getLogicalSession(logical.logicalSessionId);
          } catch (error) {
            console.warn(`[workspace-inventory] session workspace refresh failed session=${sessionId} error=${error.message}`);
          }
        }
        sendJson(response, 200, {
          logicalSession: logical,
          workspaces: logical.repositoryId
            ? store.listGitWorktrees(logical.repositoryId)
            : [],
          history: store.listProviderThreadBindings(logical.logicalSessionId).map((binding) => {
            const worktree = binding.worktreeId
              ? store.getGitWorktree(binding.worktreeId)
              : null;
            return {
              bindingId: binding.bindingId,
              providerId: binding.providerId,
              providerThreadId: binding.providerThreadId,
              state: binding.state,
              readOnly: binding.state !== "active",
              boundCwd: binding.boundCwd,
              worktreeId: binding.worktreeId,
              repositoryId: worktree?.repositoryId ?? null,
              branchName: worktree?.branchName ?? null,
              headOid: worktree?.headOid ?? null,
              availability: worktree?.availability ?? null,
              createdAt: binding.createdAt,
              updatedAt: binding.updatedAt
            };
          })
        });
      })
      .catch((error) => sendJson(response, errorStatus(error, 400), { error: error.message }));
    return true;
  }

  const sessionBindingSnapshotMatch = url.pathname.match(/^\/sessions\/([^/]+)\/bindings\/([^/]+)\/snapshot$/);
  if (request.method === "GET" && sessionBindingSnapshotMatch) {
    const sessionId = decodeURIComponent(sessionBindingSnapshotMatch[1]);
    const bindingId = decodeURIComponent(sessionBindingSnapshotMatch[2]);
    try {
      const reference = requireSessionReference(sessionId);
      const binding = store.getAgentSessionBinding(bindingId);
      if (!binding || binding.logicalSessionId !== reference.logicalSessionId) {
        const error = new Error("Session Binding not found.");
        error.code = "SESSION_BINDING_NOT_FOUND";
        throw error;
      }
      const summary = store.getSession(reference.sessionId);
      const session = storedSessionDetail({
        summary,
        storedDetail: { items: store.getItemsForBinding(reference.sessionId, bindingId) }
      });
      sendJson(response, 200, { session });
    } catch (error) {
      sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code ?? null });
    }
    return true;
  }

  const sessionWorkspaceSwitchMatch = url.pathname.match(/^\/sessions\/([^/]+)\/workspace\/switch$/);
  const unifiedSessionWorkspaceSwitchMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/actions\/switch-workspace$/
  );
  const sessionWorkspaceRecoveryMatch = url.pathname.match(/^\/sessions\/([^/]+)\/workspace\/recovery$/);
  if (sessionWorkspaceRecoveryMatch && request.method === "GET") {
    const sessionId = decodeURIComponent(sessionWorkspaceRecoveryMatch[1]);
    sessionWorkspaceRecoveryStatus(sessionId)
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, errorStatus(error, 400), { error: error.message }));
    return true;
  }
  if (sessionWorkspaceRecoveryMatch && request.method === "POST") {
    const sessionId = decodeURIComponent(sessionWorkspaceRecoveryMatch[1]);
    readJson(request)
      .then(async (input) => {
        const status = await sessionWorkspaceRecoveryStatus(sessionId);
        if (!status.orphaned) throw new Error("The session workspace is available and does not need recovery.");
        if (input.action === "switch") {
          if (!status.worktrees.some((item) => item.worktreeId === input.targetWorktreeId)) {
            throw new Error("Select an available Worktree from this repository.");
          }
          return switchSessionWorkspace(sessionId, input.targetWorktreeId);
        }
        if (input.action === "rebuild") {
          const logical = store.getLogicalSessionByLegacySessionId(sessionId);
          if (!logical.repositoryId) {
            if (status.recoveryKind !== "agentWorkspace" || status.canRebuild !== true) {
              throw new Error("This Session workspace cannot be rebuilt safely.");
            }
            const session = store.getSession(sessionId);
            const agent = session ? store.getAgent(session.agentId) : null;
            const recoveryTarget = recoverableAgentWorkDir(agent, logical.activeBinding?.boundCwd);
            if (!recoveryTarget) {
              throw new Error("This Session workspace cannot be rebuilt safely.");
            }
            const path = await ensureAgentWorkDir(agent);
            const rebuilt = { restored: { kind: "agent-workspace", path } };
            emitEvent("SessionWorkspaceRebuilt", { sessionId, rebuilt }, { sessionId });
            return rebuilt;
          }
          const rebuilt = await gitWorkspaces.restoreMissingWorktree({
            logicalSessionId: logical.logicalSessionId
          });
          if (rebuilt.restored.worktreeId !== logical.activeWorkspaceId) {
            rebuilt.transition = await switchSessionWorkspace(sessionId, rebuilt.restored.worktreeId);
          }
          emitEvent("SessionWorkspaceRebuilt", { sessionId, rebuilt }, { sessionId });
          return rebuilt;
        }
        throw new Error("Unsupported workspace recovery action.");
      })
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, errorStatus(error, 400), { error: error.message }));
    return true;
  }
  if (request.method === "POST" && (sessionWorkspaceSwitchMatch || unifiedSessionWorkspaceSwitchMatch)) {
    const sessionId = decodeURIComponent((sessionWorkspaceSwitchMatch || unifiedSessionWorkspaceSwitchMatch)[1]);
    readJson(request)
      .then(async (input) => {
        const targetWorkspaceId = input.targetWorkspaceId ?? input.targetWorktreeId;
        const result = await switchSessionWorkspace(
          sessionId,
          targetWorkspaceId,
          input.transitionId,
          input.continuationPrompt
        );
        sendJson(response, result.status === "waitingForTurn" ? 202 : 200, result);
      })
      .catch((error) => {
        sendJson(response, errorStatus(error, unifiedErrorStatus(error)), {
          error: error.message,
          code: error.code
        });
      });
    return true;
  }

  const sessionProviderSwitchMatch = url.pathname.match(/^\/sessions\/([^/]+)\/switch-provider$/);
  const unifiedSessionProviderSwitchMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/actions\/switch-provider$/
  );
  if (request.method === "POST" && (sessionProviderSwitchMatch || unifiedSessionProviderSwitchMatch)) {
    const sessionId = decodeURIComponent((sessionProviderSwitchMatch || unifiedSessionProviderSwitchMatch)[1]);
    readJson(request)
      .then(async (input) => {
        const result = await switchSessionProvider(
          sessionId,
          input.providerId,
          input.transitionId,
          input.expectedRoutingVersion
        );
        sendJson(response, result.status === "waitingForTurn" ? 202 : 200, result);
      })
      .catch((error) => {
        const current = error.code === "STALE_SESSION_ROUTE"
          ? store.getSession(sessionId)
          : null;
        sendJson(response, errorStatus(error, unifiedErrorStatus(error)), {
          error: error.message,
          code: error.code,
          ...(error.code === "STALE_SESSION_ROUTE" ? {
            expectedRoutingVersion: error.expectedRoutingVersion ?? null,
            currentRoutingVersion: error.currentRoutingVersion ?? null,
            session: current ? decorateSessionForClient(current) : null
          } : {})
        });
      });
    return true;
  }

  return false;
}
