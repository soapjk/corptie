import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

export function createProviderSessionRouteBootstrap({
  store, createGitWorkspaceSnapshot, inspectGitWorkspace,
  defaultWorkspacePath, normalizeSessionId, codexPermissionsForSession
}) {
  async function ensureLogicalRouteForProviderSession(session, providerId, options = {}) {
    if (!session?.id || !providerId) return null;
    const existing = store.getLogicalSessionByLegacySessionId(session.id);
    if (existing) return existing;
    const cwd = await realpath(session.external?.cwd || session.cwd || defaultWorkspacePath());
    let repositoryId = null;
    let worktreeId = null;
    try {
      const snapshot = await createGitWorkspaceSnapshot(cwd);
      store.upsertGitWorkspaceSnapshot(snapshot);
      const identity = await inspectGitWorkspace(cwd);
      repositoryId = identity.repositoryId;
      worktreeId = identity.worktreeId;
    } catch {
      // Non-Git workspaces keep a route without repository/worktree identity.
    }
    const providerThreadId = session.external?.threadId
      || session.external?.sessionId
      || normalizeSessionId(session.id);
    const permissions = providerId === "codex-app-server"
      ? codexPermissionsForSession(session)
      : {
          approvalPolicy: session.external?.approvalPolicy ?? options.approvalPolicy ?? null,
          sandbox: session.external?.sandbox ?? options.sandbox ?? null
        };
    try {
      return store.createLogicalSessionRoute({
        logicalSessionId: `logical:${randomUUID()}`,
        legacySessionId: session.id,
        providerThreadId,
        providerId,
        providerSessionId: providerThreadId,
        repositoryId,
        worktreeId,
        boundCwd: cwd,
        instructionSources: options.instructionSources ?? [],
        permissionSnapshot: {
          cwd,
          runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? [cwd],
          approvalPolicy: options.approvalPolicy ?? permissions.approvalPolicy,
          sandboxPolicy: options.sandboxPolicy ?? (permissions.sandbox ? { type: permissions.sandbox } : null)
        },
        providerMetadata: options.providerMetadata ?? {},
        title: session.title,
        pinned: session.pinned,
        archived: session.archived
      });
    } catch (error) {
      const raced = store.getLogicalSessionByLegacySessionId(session.id);
      if (raced) return raced;
      throw error;
    }
  }

  async function ensureLogicalRouteForCodexSession(session, appServerResponse = null) {
    if (!session?.id || !session.id.startsWith("codex:")) return null;
    return ensureLogicalRouteForProviderSession(session, "codex-app-server", appServerResponse ?? {});
  }

  return Object.freeze({ ensureLogicalRouteForProviderSession, ensureLogicalRouteForCodexSession });
}
