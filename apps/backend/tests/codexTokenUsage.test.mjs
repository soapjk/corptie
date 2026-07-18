import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodexTokenUsage, tokenUsageFromCodexRolloutText } from "../src/adapters/codexAppServer.mjs";

test("normalizes Codex token usage and computes context balance", () => {
  assert.deepEqual(normalizeCodexTokenUsage({
    total: { totalTokens: 32_000 },
    modelContextWindow: 128_000
  }), {
    usedTokens: 32_000,
    contextWindow: 128_000,
    remainingTokens: 96_000,
    usedPercent: 25
  });
});

test("accepts snake case token usage fields", () => {
  assert.equal(normalizeCodexTokenUsage({
    total_usage: { total_tokens: 1_500 },
    model_context_window: 2_000
  })?.remainingTokens, 500);
});

test("uses the latest context instead of cumulative account tokens", () => {
  assert.equal(normalizeCodexTokenUsage({
    total: { totalTokens: 300_000 },
    last: { totalTokens: 24_000 },
    modelContextWindow: 128_000
  })?.remainingTokens, 104_000);
});

test("reads the latest context snapshot from an existing rollout", () => {
  const text = [
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { total_tokens: 20_000 }, model_context_window: 100_000
    } } }),
    "malformed rollout tail",
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { total_tokens: 35_000 }, model_context_window: 100_000
    } } })
  ].join("\n");

  assert.equal(tokenUsageFromCodexRolloutText(text)?.remainingTokens, 65_000);
});
