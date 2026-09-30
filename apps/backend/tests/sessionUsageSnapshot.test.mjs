import assert from "node:assert/strict";
import test from "node:test";
import { loadSessionUsageSnapshot } from "../src/application/sessionUsageSnapshot.mjs";

test("session usage keeps context data when account quota loading fails", async () => {
  const persisted = [];
  const snapshot = await loadSessionUsageSnapshot({
    loadAccount: async () => { throw new Error("rate-limit API unavailable"); },
    loadContext: async () => ({ usedTokens: 25, contextWindow: 100, remainingTokens: 75 }),
    fallbackAccount: { available: true, provider: "codex", cached: true },
    persistAccount: async (account) => persisted.push(account)
  });
  assert.deepEqual(snapshot, {
    account: { available: true, provider: "codex", cached: true },
    context: { usedTokens: 25, contextWindow: 100, remainingTokens: 75 },
    resetForecast: null
  });
  assert.deepEqual(persisted, []);
});

test("session usage keeps account quota when context loading fails", async () => {
  const persisted = [];
  const snapshot = await loadSessionUsageSnapshot({
    loadAccount: async () => ({ available: true, provider: "claude", rateLimits: { primary: {} } }),
    loadContext: async () => { throw new Error("context unavailable"); },
    fallbackAccount: { available: false, provider: "claude" },
    persistAccount: async (account) => persisted.push(account),
    resetForecast: { forecast: null }
  });
  assert.deepEqual(snapshot, {
    account: { available: true, provider: "claude", rateLimits: { primary: {} } },
    context: null,
    resetForecast: { forecast: null }
  });
  assert.deepEqual(persisted, [
    { available: true, provider: "claude", rateLimits: { primary: {} } }
  ]);
});

test("strict account refresh rejects cached quota after Provider failure", async () => {
  await assert.rejects(loadSessionUsageSnapshot({
    loadAccount: async () => { throw new Error("rate-limit API unavailable"); },
    loadContext: async () => ({ usedTokens: 25 }),
    fallbackAccount: { available: true, provider: "codex", rateLimitResetCredits: { availableCount: 2 } },
    requireFreshAccount: true
  }), { code: "ACCOUNT_USAGE_REFRESH_FAILED" });
});
