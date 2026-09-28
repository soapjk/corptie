import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeAssistantContentItems, finalizeClaudeTurnItems,
  claudeStructuredToolResult, normalizeClaudeAccountUsage
} from "../src/adapters/claudeMessageProjection.mjs";

test("assistant projection preserves text, reasoning and tool identity", () => {
  const items = claudeAssistantContentItems({ content: [
    { type: "text", text: " hello " },
    { type: "thinking", thinking: " reason " },
    { type: "tool_use", name: "Bash", id: "tool", input: { command: "pwd" } }
  ] });
  assert.deepEqual(items.map((item) => item.type), ["agentMessage", "reasoning", "commandExecution"]);
  assert.equal(items[0].presentationRole, "commentary");
  assert.equal(items[2].toolUseId, "tool");
  assert.equal(items[2].text, "pwd");
});

test("turn finalization only promotes the final non-continuation agent message", () => {
  const session = { items: [
    { id: "a", turnId: "turn", type: "agentMessage" },
    { id: "tool", turnId: "turn", type: "commandExecution" },
    { id: "b", turnId: "turn", type: "agentMessage" },
    { id: "other", turnId: "other", type: "agentMessage", turnStatus: "inProgress" }
  ], toolContinuationItemIds: new Set() };
  finalizeClaudeTurnItems(session, "turn", "completed");
  assert.equal(session.items[0].presentationRole, "commentary");
  assert.equal(session.items[2].presentationRole, "final_answer");
  assert.equal(session.items[3].turnStatus, "inProgress");
  session.toolContinuationItemIds.add("b");
  finalizeClaudeTurnItems(session, "turn", "completed");
  assert.equal(session.items[2].presentationRole, "commentary");
});

test("structured tool result and usage projection retain their fallback rules", () => {
  const result = { ok: true };
  assert.equal(claudeStructuredToolResult({ tool_use_result: result }, {}, 1), result);
  assert.deepEqual(claudeStructuredToolResult({}, { content: '{"ok":true}' }, 2), result);
  assert.equal(claudeStructuredToolResult({}, { content: "[]" }, 1), null);
  const usage = normalizeClaudeAccountUsage({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: "2026-01-01T00:00:00Z" } }
  }, "model");
  assert.equal(usage.available, true);
  assert.equal(usage.rateLimits.primary.usedPercent, 12);
  assert.equal(usage.model, "model");
});
