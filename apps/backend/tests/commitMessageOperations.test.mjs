import assert from "node:assert/strict";
import test from "node:test";
import { createCommitMessageOperations } from "../src/application/commitMessageOperations.mjs";

function fixture() {
  const calls = [];
  const session = { status: "idle", external: { currentModel: "model", currentReasoningLevel: "high" } };
  const logical = { activeBinding: {}, transitionState: "idle" };
  const reference = { sessionId: "stored", logicalSessionId: "logical", providerId: "test", providerSessionId: "native", metadata: { session } };
  const service = { run: async (input) => { calls.push(input); return { text: "Refactor session commands" }; } };
  const operations = createCommitMessageOperations({
    store: { getSession: () => session, getLogicalSession: () => logical },
    sessionApplicationService: { referenceFor: async () => reference },
    sessionBindingRepository: { resolve: () => reference },
    backgroundAgentService: service,
    assertWorkspaceRouteUsable: async () => ({ cwd: "/workspace" })
  });
  return { calls, session, logical, service, operations };
}

test("owned generation inherits provider preferences and is bounded to the active workspace", async () => {
  const f = fixture();
  assert.equal(await f.operations.generateSessionCommitMessage("session", {}), "Refactor session commands");
  assert.equal(f.calls[0].purpose, "commit-message");
  assert.deepEqual(f.calls[0].allowedRoots, ["/workspace"]);
  assert.equal(f.calls[0].preferredProviderId, "test");
  assert.equal(f.calls[0].preferredModel, "model");
  assert.equal(f.calls[0].preferredReasoning, "high");
});

test("busy or transitioning sessions cannot start background commit generation", async () => {
  const f = fixture();
  f.session.status = "running";
  await assert.rejects(f.operations.generateSessionCommitMessage("session", {}), { code: "SESSION_BUSY" });
  f.session.status = "idle";
  f.logical.transitionState = "sessionRecovery";
  await assert.rejects(f.operations.generateSessionCommitMessage("session", {}), { code: "SESSION_BUSY" });
  assert.deepEqual(f.calls, []);
});

test("unowned worktree generation supports no requesting session and rejects empty output", async () => {
  const f = fixture();
  await f.operations.generateUnownedWorktreeCommitMessage(null, "/other", {});
  assert.deepEqual(f.calls[0].allowedRoots, ["/other"]);
  assert.equal(f.calls[0].preferredProviderId, undefined);
  f.service.run = async () => ({ text: " " });
  await assert.rejects(f.operations.generateUnownedWorktreeCommitMessage("session", "/other", {}), /empty commit message/);
});
