export class WorkspaceRoutePreparationCache {
  constructor(options = {}) {
    this.ttlMs = positiveNumber(options.ttlMs, 15_000);
    this.now = options.now ?? Date.now;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  async resolve(input = {}) {
    const logical = input.logicalSession;
    const key = workspaceRoutePreparationKey(input.store, logical, input.providerThreadId);
    const cached = this.entries.get(key);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return { route: cached.route, cacheHit: true };
    }
    if (cached) this.entries.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) {
      return { route: await pending, cacheHit: true, coalesced: true };
    }

    if (typeof input.resolve !== "function") {
      throw new TypeError("Workspace route preparation requires a resolver.");
    }
    const promise = Promise.resolve().then(input.resolve);
    this.inFlight.set(key, promise);
    try {
      const route = await promise;
      this.entries.set(key, { route, expiresAt: this.now() + this.ttlMs });
      this.#pruneLogicalSession(logical?.logicalSessionId, key);
      return { route, cacheHit: false };
    } finally {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }
  }

  invalidate(logicalSessionId = null) {
    if (!logicalSessionId) {
      this.entries.clear();
      return;
    }
    const prefix = `${logicalSessionId}\u0000`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  #pruneLogicalSession(logicalSessionId, retainedKey) {
    if (!logicalSessionId) return;
    const prefix = `${logicalSessionId}\u0000`;
    for (const key of this.entries.keys()) {
      if (key !== retainedKey && key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

export function workspaceRoutePreparationKey(store, logical, providerThreadId) {
  if (!logical?.logicalSessionId) {
    throw new TypeError("Workspace route preparation requires a logical Session.");
  }
  const worktree = logical.activeWorkspaceId && store?.getGitWorktree
    ? store.getGitWorktree(logical.activeWorkspaceId)
    : null;
  return `${logical.logicalSessionId}\u0000${JSON.stringify({
    providerThreadId: providerThreadId ?? null,
    activeThreadId: logical.activeThreadId ?? null,
    routingVersion: logical.routingVersion ?? null,
    repositoryId: logical.repositoryId ?? null,
    activeWorkspaceId: logical.activeWorkspaceId ?? null,
    boundCwd: logical.activeBinding?.boundCwd ?? null,
    worktree: worktree ? {
      worktreeId: worktree.worktreeId ?? null,
      availability: worktree.availability ?? null,
      canonicalPath: worktree.canonicalPath ?? null,
      path: worktree.path ?? null,
      inventoryVersion: worktree.inventoryVersion ?? null
    } : null
  })}`;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
