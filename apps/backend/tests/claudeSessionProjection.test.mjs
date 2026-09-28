import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionDetail, claudeSessionSummary } from "../src/adapters/claudeSessionProjection.mjs";

test("pending structured input blocks sends without requiring a legacy choice", () => {
  const session = {
    id: "session", status: "complete", turnState: "idle",
    pendingChoices: new Map(), pendingInteractions: new Map([["input", {}]]),
    items: [], provider: "claude-sdk"
  };
  const detail = claudeSessionDetail(session, 20);
  assert.equal(detail.status, "blocked");
  assert.equal(detail.canSend, false);
  assert.equal(detail.capabilities.canSend, false);
  assert.equal(detail.activityStatus, "Waiting for your choice");
});

test("cancelled turns remain sendable and summary preserves stored metadata", () => {
  const session = {
    id: "session", title: "Chat", status: "cancelled", turnState: "idle",
    items: [{ id: "old", type: "agentMessage", text: "old" },
      { id: "new", type: "agentMessage", text: "latest" }],
    provider: "claude-sdk", pinned: false
  };
  const detail = claudeSessionDetail(session, 1);
  assert.equal(detail.canSend, true);
  assert.deepEqual(detail.items.map(item => item.id), ["new"]);
  const summary = claudeSessionSummary(session, { pinned: true, sortOrder: 8, sessionKind: "worker" }, detail);
  assert.equal(summary.summary, "latest");
  assert.equal(summary.pinned, true);
  assert.equal(summary.sortOrder, 8);
  assert.equal(summary.sessionKind, "worker");
});
