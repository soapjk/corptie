import assert from "node:assert/strict";
import test from "node:test";
import { loadSessionUsageSnapshot } from "../src/application/sessionUsageSnapshot.mjs";

test("session usage keeps context data when account quota loading fails", async () => {
  const snapshot = await loadSessionUsageSnapshot({
    loadAccount: async () => { throw new Error("rate-limit API unavailable"); },
    loadContext: async () => ({ usedTokens: 25, contextWindow: 100, remainingTokens: 75 }),
    fallbackAccount: { available: false, provider: "codex" }
  });
  assert.deepEqual(snapshot, {
    account: { available: false, provider: "codex" },
    context: { usedTokens: 25, contextWindow: 100, remainingTokens: 75 },
    resetForecast: null
  });
});

test("session usage keeps account quota when context loading fails", async () => {
  const snapshot = await loadSessionUsageSnapshot({
    loadAccount: async () => ({ available: true, provider: "claude", rateLimits: {} }),
    loadContext: async () => { throw new Error("context unavailable"); },
    fallbackAccount: { available: false, provider: "claude" },
    resetForecast: { forecast: null }
  });
  assert.deepEqual(snapshot, {
    account: { available: true, provider: "claude", rateLimits: {} },
    context: null,
    resetForecast: { forecast: null }
  });
});
