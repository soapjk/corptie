import assert from "node:assert/strict";
import test from "node:test";
import { providerLifecycleMetadataDecision } from "../src/application/providerLifecycleOrdering.mjs";

test("late final item repairs content without regressing a completed Session", () => {
  const decision = providerLifecycleMetadataDecision({
    eventName: "item/completed",
    eventTurnId: "turn:final",
    session: {
      status: "complete",
      external: { activeTurnId: null, lastSettledTurnId: "turn:final" }
    }
  });
  assert.deepEqual(decision, { applyMetadata: false, reason: "settled_turn_item" });
});

test("an older completion cannot terminate a newer active turn", () => {
  const decision = providerLifecycleMetadataDecision({
    eventName: "turn/completed",
    eventTurnId: "turn:old",
    session: {
      status: "running",
      external: { activeTurnId: "turn:new", lastSettledTurnId: null }
    }
  });
  assert.deepEqual(decision, { applyMetadata: false, reason: "non_active_turn_completion" });
});

test("active turn lifecycle remains applicable", () => {
  assert.equal(providerLifecycleMetadataDecision({
    eventName: "item/completed",
    eventTurnId: "turn:active",
    session: { status: "running", external: { activeTurnId: "turn:active" } }
  }).applyMetadata, true);
});

test("a terminal completion without a turn id cannot republish settled metadata", () => {
  const decision = providerLifecycleMetadataDecision({
    eventName: "turn/completed",
    eventTurnId: null,
    session: { status: "complete", external: { activeTurnId: null } }
  });
  assert.deepEqual(decision, { applyMetadata: false, reason: "terminal_session_completion" });
});
