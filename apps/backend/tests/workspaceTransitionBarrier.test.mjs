import assert from "node:assert/strict";
import test from "node:test";
import {
  resumeWorkAfterTransition,
  workspaceTransitionBlocksWork
} from "../src/runtime/workspaceTransitionBarrier.mjs";

test("workspace transition state blocks queued work until route selection is final", () => {
  assert.equal(workspaceTransitionBlocksWork({ transitionState: "waitingForTurn" }), true);
  assert.equal(workspaceTransitionBlocksWork({ transitionState: "committingRoute" }), true);
  assert.equal(workspaceTransitionBlocksWork({ transitionState: "sessionRecovery" }), true);
  assert.equal(workspaceTransitionBlocksWork({ transitionState: "failed" }), false);
  assert.equal(workspaceTransitionBlocksWork({ transitionState: "committed" }), false);
  assert.equal(workspaceTransitionBlocksWork({ transitionState: null }), false);
});

test("queued work resumes only after a transition settles", async () => {
  let settle;
  const transition = new Promise((resolve) => {
    settle = resolve;
  });
  let resumed = false;
  const waiting = resumeWorkAfterTransition(transition, () => {
    resumed = true;
  });
  await Promise.resolve();
  assert.equal(resumed, false);
  settle();
  await waiting;
  assert.equal(resumed, true);
});

test("queued work resumes immediately when no transition exists", () => {
  let resumed = false;
  const result = resumeWorkAfterTransition(null, () => {
    resumed = true;
  });
  assert.equal(result, null);
  assert.equal(resumed, true);
});
