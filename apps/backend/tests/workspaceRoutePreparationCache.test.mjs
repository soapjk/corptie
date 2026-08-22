import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceRoutePreparationCache } from "../src/runtime/workspaceRoutePreparationCache.mjs";

function logical(overrides = {}) {
  return {
    logicalSessionId: "logical:one",
    activeThreadId: "thread:one",
    routingVersion: 3,
    repositoryId: "repository:one",
    activeWorkspaceId: "worktree:one",
    activeBinding: { boundCwd: "/tmp/one" },
    ...overrides
  };
}

function store(worktreeOverrides = {}) {
  return {
    getGitWorktree: () => ({
      worktreeId: "worktree:one",
      availability: "available",
      canonicalPath: "/tmp/one",
      inventoryVersion: "inventory:one",
      ...worktreeOverrides
    })
  };
}

test("workspace route preparation cache reuses a valid versioned route", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new WorkspaceRoutePreparationCache({ ttlMs: 100, now: () => now });
  const input = {
    store: store(),
    logicalSession: logical(),
    providerThreadId: "thread:one",
    resolve: async () => ({ cwd: "/tmp/one", call: ++calls })
  };

  const first = await cache.resolve(input);
  const second = await cache.resolve(input);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.route.call, 1);

  now += 101;
  const expired = await cache.resolve(input);
  assert.equal(expired.cacheHit, false);
  assert.equal(expired.route.call, 2);
});

test("workspace route preparation cache invalidates when route or inventory changes", async () => {
  let calls = 0;
  const cache = new WorkspaceRoutePreparationCache();
  const resolve = async () => ({ call: ++calls });

  await cache.resolve({ store: store(), logicalSession: logical(), providerThreadId: "thread:one", resolve });
  const rerouted = await cache.resolve({
    store: store(),
    logicalSession: logical({ routingVersion: 4 }),
    providerThreadId: "thread:one",
    resolve
  });
  const refreshedInventory = await cache.resolve({
    store: store({ inventoryVersion: "inventory:two" }),
    logicalSession: logical({ routingVersion: 4 }),
    providerThreadId: "thread:one",
    resolve
  });

  assert.equal(rerouted.cacheHit, false);
  assert.equal(refreshedInventory.cacheHit, false);
  assert.equal(calls, 3);
});

test("workspace route preparation cache ignores observation timestamps when identity is unchanged", async () => {
  let calls = 0;
  const cache = new WorkspaceRoutePreparationCache();
  const first = {
    store: store({ observedAt: "2026-08-22T10:00:00.000Z" }),
    logicalSession: logical(),
    providerThreadId: "thread:one",
    resolve: async () => ({ call: ++calls })
  };
  await cache.resolve(first);
  const observedAgain = await cache.resolve({
    ...first,
    store: store({ observedAt: "2026-08-22T10:00:05.000Z" })
  });

  assert.equal(observedAgain.cacheHit, true);
  assert.equal(calls, 1);
});

test("workspace route preparation cache coalesces concurrent validation", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new WorkspaceRoutePreparationCache();
  const input = {
    store: store(),
    logicalSession: logical(),
    providerThreadId: "thread:one",
    resolve: async () => {
      calls += 1;
      await gate;
      return { cwd: "/tmp/one" };
    }
  };

  const first = cache.resolve(input);
  const second = cache.resolve(input);
  release();
  const [, coalesced] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(coalesced.cacheHit, true);
  assert.equal(coalesced.coalesced, true);
});
