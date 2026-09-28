export function createWorkspaceSessionToolAuthority({
  store, collaborationCore, getSessionWorkspaceOperations
}) {
  function workspaceInventory(logical) {
    return {
      logicalSessionId: logical.logicalSessionId,
      activeWorktreeId: logical.activeWorkspaceId,
      activeRepositoryId: logical.repositoryId,
      workspaces: store.listAllGitWorktrees().map((worktree) => ({
        id: worktree.worktreeId,
        repositoryId: worktree.repositoryId,
        path: worktree.canonicalPath || worktree.path,
        availability: worktree.availability,
        branchName: worktree.branchName,
        headOid: worktree.headOid,
        detached: worktree.isDetached,
        isMain: worktree.isMain
      }))
    };
  }

  function requireAgentLogicalSession(agentId) {
    const agent = collaborationCore.getAgent(agentId);
    const sessionId = agent?.currentSessionId;
    const logical = sessionId ? store.getLogicalSessionByLegacySessionId(sessionId) : null;
    if (!sessionId || !logical?.activeBinding) {
      const error = new Error("The Corptie Agent is not bound to an active logical Session.");
      error.code = "SESSION_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    return { agent, sessionId, logical };
  }

  async function callWorkspaceDynamicTool(params) {
    const logical = store.getLogicalSessionByProviderThreadId(params.threadId);
    if (!logical || logical.activeThreadId !== params.threadId) {
      const error = new Error("Workspace operations are only available from the active logical Session thread.");
      error.code = "WORKSPACE_SESSION_ROUTE_STALE";
      error.stage = "route_validation";
      throw error;
    }
    const metadata = params.metadata ?? {};
    const operations = getSessionWorkspaceOperations();
    if (params.tool === "corptie_list_workspaces") {
      return operations.listWorkspaces(metadata, params.actorId);
    }
    if (params.tool === "corptie_create_worktree") {
      return operations.createWorktree(metadata, params.actorId, params.arguments ?? {});
    }
    if (params.tool === "corptie_switch_workspace") {
      return operations.switchWorkspace(metadata, params.actorId, params.arguments ?? {});
    }
    throw new Error(`Unsupported workspace tool: ${params.tool}`);
  }

  function validateProjectCodeHostRoute(params) {
    const logical = store.getLogicalSessionByProviderThreadId(params.threadId);
    if (!logical || logical.activeThreadId !== params.threadId
      || logical.logicalSessionId !== params.metadata?.logicalSessionId) {
      const error = new Error("Project-code search is only available from the active authoritative Worker Session thread.");
      error.code = "PROJECT_CODE_SESSION_ROUTE_STALE";
      error.stage = "route_validation";
      throw error;
    }
  }

  return {
    workspaceInventory, requireAgentLogicalSession,
    callWorkspaceDynamicTool, validateProjectCodeHostRoute
  };
}
