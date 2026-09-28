import assert from "node:assert/strict";
import test from "node:test";
import { createCodexSessionCommands } from "../src/adapters/codexSessionCommands.mjs";
import { createCodexTurnDispatcher } from "../src/adapters/codexTurnDispatcher.mjs";

test("turn dispatch refuses a transitioning workspace before modifying choices or contacting the Provider", async () => {
  const calls = [];
  const dispatcher = createCodexTurnDispatcher({
    store: {
      getLogicalSessionByLegacySessionId: () => ({ transitionState: "committingRoute" }),
      clearActiveChoicePrompt: () => calls.push("clear")
    },
    codexRuntime: { startTurn: async () => calls.push("start") },
    bumpChoiceGeneration: () => calls.push("choice")
  });
  await assert.rejects(dispatcher.sendCodexProviderMessage({
    sessionId: "session:1", providerSessionId: "native:1"
  }, "hello"), { code: "SESSION_BUSY" });
  assert.deepEqual(calls, []);
});

test("resume finalization binds fresh-thread context without attempting a native rollout resume", async () => {
  const calls = [];
  const session = { id: "session:1" };
  const commands = createCodexSessionCommands({
    store: { getSession: () => session },
    codexRuntime: {
      bindThreadToolContext: (...args) => calls.push(["bind", ...args]),
      ensureThreadResumed: async (...args) => calls.push(["ensure", ...args]),
      resumeThread: async (...args) => calls.push(["resume", ...args]),
      unarchiveThread: async (...args) => calls.push(["unarchive", ...args])
    },
    withPersistedCodexToolConfirmation: (_reference, options) => options,
    collaborationThreadOptionsForSession: async () => ({ dynamicTools: [] })
  });
  const reference = { sessionId: session.id, providerSessionId: "native:1" };
  assert.equal(await commands.resumeCodexProviderSession(reference, {
    purpose: "session-create-finalization"
  }), session);
  await commands.resumeCodexProviderSession(reference, { purpose: "session-recovery-validation" });
  await commands.resumeCodexProviderSession(reference, { purpose: "session-unarchive" });
  assert.deepEqual(calls.map(([kind]) => kind), ["bind", "ensure", "unarchive", "resume"]);
});

test("binding probe rejects stale identity before touching the Provider", async () => {
  let probed = false;
  const commands = createCodexSessionCommands({
    store: { getLogicalSession: () => ({ activeBinding: { bindingId: "new" } }) },
    codexRuntime: { ensureThreadResumed: async () => { probed = true; } }
  });
  await assert.rejects(commands.probeCodexProviderBinding({
    logicalSessionId: "logical:1", bindingId: "old", providerSessionId: "native:1"
  }), { code: "SESSION_BINDING_CHANGED" });
  assert.equal(probed, false);
});

test("native deletion invalidates only workspace preparation, never the product Session", async () => {
  const calls = [];
  const commands = createCodexSessionCommands({
    store: {},
    codexRuntime: { deleteThread: async (id) => calls.push(["delete-native", id]) },
    invalidateWorkspaceRoute: (id) => calls.push(["invalidate", id])
  });
  assert.equal(await commands.deleteCodexProviderSession({
    providerSessionId: "replacement", sessionId: "stable", logicalSessionId: "logical:1"
  }), true);
  assert.deepEqual(calls, [["delete-native", "replacement"], ["invalidate", "logical:1"]]);
});

function fixture() {
  const calls = [];
  const session = { id: "stored", status: "blocked", external: { activeTurnId: "turn", currentModel: "old" } };
  const reference = { sessionId: "stored", providerSessionId: "native", metadata: { session } };
  const commands = createCodexSessionCommands({
    store: {
      getSession: () => session,
      clearActiveChoicePrompt: (id) => calls.push(["clear", id])
    },
    codexRuntime: {
      interruptTurn: async (...args) => calls.push(["interrupt", ...args]),
      respondToApproval: async (...args) => calls.push(["approval", ...args]),
      respondToUserInput: async (...args) => calls.push(["input", ...args])
    },
    now: () => "2026-01-01T00:00:00Z",
    codexAppServerSessionCapabilities: () => ({}),
    upsertManagedCodexSession: (value) => calls.push(["upsert", value])
  });
  return { calls, commands, reference, session };
}

test("interrupt uses the active turn without fabricating a terminal projection", async () => {
  const f = fixture();
  assert.equal(await f.commands.interruptCodexProviderSession(f.reference), f.session);
  assert.deepEqual(f.calls, [["interrupt", "native", "turn"]]);
  assert.equal(f.session.status, "blocked");
  delete f.session.external.activeTurnId;
  await assert.rejects(f.commands.interruptCodexProviderSession(f.reference), { code: "NO_ACTIVE_RUN" });
});

test("approval clears the choice prompt only after transport acknowledgement", async () => {
  const f = fixture();
  assert.equal(await f.commands.respondCodexProviderApproval(f.reference, {
    approved: true, optionId: "yes", choiceId: "choice"
  }), f.session);
  assert.deepEqual(f.calls, [
    ["approval", "native", { approved: true, optionId: "yes", itemId: "choice" }],
    ["clear", "stored"]
  ]);
  assert.equal(f.session.status, "blocked");
});

test("user input response preserves durable status while forwarding answers", async () => {
  const f = fixture();
  const input = { itemId: "item", action: "submit", answers: { question: ["yes"] } };
  assert.equal(await f.commands.respondCodexProviderUserInput(f.reference, input), f.session);
  assert.deepEqual(f.calls, [["input", "native", input]]);
});

test("configuration updates preserve unrelated session state", () => {
  const f = fixture();
  const updated = f.commands.updateCodexProviderConfiguration(f.reference, { currentModel: "new" });
  assert.equal(updated.status, "blocked");
  assert.equal(updated.external.activeTurnId, "turn");
  assert.equal(updated.external.currentModel, "new");
  assert.equal(updated.capabilities.canSwitchModel, true);
  assert.equal(f.calls[0][0], "upsert");
});
