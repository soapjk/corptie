import { realpath } from "node:fs/promises";
import { inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";

const TRANSIENT_INSPECTION_CODES = new Set([
  "EAGAIN", "EBUSY", "EIO", "EMFILE", "ENFILE", "ESTALE", "ETIMEDOUT"
]);

export async function assertWorkspaceRouteUsable(input) {
  const logical = input?.logicalSession;
  if (!logical?.activeBinding?.boundCwd) {
    throw routeError("WORKSPACE_ROUTE_MISSING", "The session has no active workspace route.");
  }

  if (input.providerThreadId && logical.activeThreadId !== input.providerThreadId) {
    if (input.allowHistorical === true) {
      return assertHistoricalWorkspaceUsable(input, logical);
    }
    throw routeError("STALE_WORKSPACE_ROUTE", `Thread ${input.providerThreadId} is no longer active for this session.`);
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
    identity = await inspectWorkspaceWithRetry(
      input.inspectWorkspace ?? inspectGitWorkspace,
      binding.boundCwd,
      input
    );
  } catch (cause) {
    const transient = isTransientInspectionError(cause);
    console.warn(`[workspace-route] ${JSON.stringify({
      event: "inspection_failed",
      logicalSessionId: logical.logicalSessionId,
      worktreeId: logical.activeWorkspaceId,
      code: cause?.code ?? null,
      transient
    })}`);
    throw routeError(
      transient ? "WORKSPACE_INSPECTION_TRANSIENT" : "WORKSPACE_UNAVAILABLE",
      transient
        ? "The active Git worktree could not be verified after retrying. Try the message again."
        : "The active Git worktree path is missing or is no longer a valid Git workspace.",
      { cause, retryable: transient }
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

async function assertHistoricalWorkspaceUsable(input, logical) {
  const binding = input.store.getProviderThreadBinding(input.providerThreadId);
  if (!binding
    || binding.logicalSessionId !== logical.logicalSessionId
    || binding.state === "active") {
    throw routeError("STALE_WORKSPACE_ROUTE", `Thread ${input.providerThreadId} is not a historical route for this session.`);
  }
  const worktree = binding.worktreeId
    ? input.store.getGitWorktree(binding.worktreeId)
    : null;
  if (binding.worktreeId && (!worktree || worktree.availability !== "available")) {
    throw routeError("WORKSPACE_UNAVAILABLE", "The historical Git worktree is unavailable.");
  }
  try {
    if (binding.worktreeId) {
      const identity = await (input.inspectWorkspace ?? inspectGitWorkspace)(binding.boundCwd);
      if (
        identity.worktreeId !== binding.worktreeId
        || identity.repositoryId !== worktree.repositoryId
      ) {
        throw routeError("WORKSPACE_IDENTITY_CHANGED", "The historical path now resolves to a different Git worktree.");
      }
      return routeMetadata(logical, binding, identity.canonicalPath);
    }
    return routeMetadata(
      logical,
      binding,
      await (input.realpath ?? realpath)(binding.boundCwd)
    );
  } catch (error) {
    if (error?.code && error.statusCode) throw error;
    throw routeError("WORKSPACE_UNAVAILABLE", "The historical workspace path is unavailable.");
  }
}

function routeMetadata(logical, binding, cwd) {
  return {
    cwd,
    logicalSessionId: logical.logicalSessionId,
    providerThreadId: binding.providerThreadId,
    worktreeId: binding.worktreeId ?? null,
    routingVersion: binding.routingVersion,
    historical: binding.state !== "active"
  };
}

async function inspectWorkspaceWithRetry(inspect, cwd, input) {
  const retries = Number.isSafeInteger(input.workspaceInspectionRetries)
    ? Math.max(0, input.workspaceInspectionRetries)
    : 2;
  const wait = input.wait ?? retryDelay;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await inspect(cwd);
    } catch (error) {
      lastError = error;
      if (!isTransientInspectionError(error) || attempt === retries) throw error;
      await wait(50 * (attempt + 1));
    }
  }
  throw lastError;
}

function isTransientInspectionError(error) {
  return TRANSIENT_INSPECTION_CODES.has(error?.code)
    || TRANSIENT_INSPECTION_CODES.has(error?.cause?.code);
}

function retryDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function routeError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  error.retryable = options.retryable === true;
  if (options.cause) error.cause = options.cause;
  return error;
}
