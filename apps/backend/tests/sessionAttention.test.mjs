import test from "node:test";
import assert from "node:assert/strict";
import { sessionAttention } from "../src/utils/sessionAttention.mjs";

test("blocked is not inferred to be a question or an approval", () => {
  assert.deepEqual(sessionAttention({ status: "blocked", updatedAt: "now" }), {
    kind: "blocked", reason: null, sourceId: null, updatedAt: "now"
  });
});

test("only active structured choices expose a choice reason", () => {
  const choice = { id: "choice:1", status: "active", prompt: "Choose", options: [{}, {}], createdAt: "then" };
  assert.equal(sessionAttention({ status: "blocked", choice }).reason, "Choose");
  assert.equal(sessionAttention({ status: "running", choice }), null);
  assert.equal(sessionAttention({ status: "cancelled", choice }), null);
  assert.equal(sessionAttention({ status: "idle", choice: { ...choice, status: "resolved" } }), null);
});

test("failure reason is optional and never synthesized from summary", () => {
  assert.equal(sessionAttention({ status: "failed", summary: "old reply" }).reason, null);
  assert.equal(sessionAttention({ status: "failed", failureReason: "transport lost" }).reason, "transport lost");
});

test("shared contract does not branch on adapter branding", () => {
  for (const provider of ["codex-app-server", "claude-agent", "openclacky", "future-provider"]) {
    assert.equal(sessionAttention({ provider, status: "blocked" }).kind, "blocked");
    assert.equal(sessionAttention({ provider, status: "complete" }), null);
  }
});
