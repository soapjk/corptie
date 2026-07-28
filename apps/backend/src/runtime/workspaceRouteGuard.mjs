import { realpath } from "node:fs/promises";
import { inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";

export async function assertWorkspaceRouteUsable(input) {
  const logical = input?.logicalSession;
  if (!logical?.activeBinding?.boundCwd) {
    throw routeError("WORKSPACE_ROUTE_MISSING", "The session has no active workspace route.");
  }

  if (input.providerThreadId && logical.activeThreadId !== input.providerThreadId) {
    throw routeError(
      "STALE_WORKSPACE_ROUTE",
      `Thread ${input.providerThreadId} is no longer active for this session.`
    );
  }

  const binding = logical.activeBinding;
  const worktree = logical.activeWorkspaceId
    ? input.store.getGitWorktree(logical.activeWorkspaceId)
    : null;
  if (logical.activeWorkspaceId && (!worktree || worktree.availability !== "available")) {
    throw routeError(
      "WORKSPACE_UNAVAILABLE",
      "The active Git worktree is unavailable. Restore or switch the workspace before continuing."
    );
  }

  if (!logical.repositoryId || !logical.activeWorkspaceId) {
    try {
      return {
        cwd: await (input.realpath ?? realpath)(binding.boundCwd),
        logicalSessionId: logical.logicalSessionId,
        providerThreadId: logical.activeThreadId,
        worktreeId: logical.activeWorkspaceId ?? null,
        routingVersion: logical.routingVersion
      };
    } catch {
      throw routeError(
        "WORKSPACE_UNAVAILABLE",
        "The active workspace path is unavailable. Restore or switch the workspace before continuing."
      );
    }
  }

  let identity;
  try {
    identity = await (input.inspectWorkspace ?? inspectGitWorkspace)(binding.boundCwd);
  } catch {
    throw routeError(
      "WORKSPACE_UNAVAILABLE",
      "The active Git worktree path is missing or is no longer a valid Git workspace."
    );
  }
  if (
    identity.repositoryId !== logical.repositoryId
    || identity.worktreeId !== logical.activeWorkspaceId
  ) {
    throw routeError(
      "WORKSPACE_IDENTITY_CHANGED",
      "The active workspace path now resolves to a different Git worktree."
    );
  }

  return {
    cwd: identity.canonicalPath,
    logicalSessionId: logical.logicalSessionId,
    providerThreadId: logical.activeThreadId,
    worktreeId: logical.activeWorkspaceId,
    routingVersion: logical.routingVersion
  };
}

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}
