import assert from "node:assert/strict";
import test from "node:test";
import { createCodexSessionCommands } from "../src/adapters/codexSessionCommands.mjs";
import { createCodexTurnDispatcher } from "../src/adapters/codexTurnDispatcher.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

test("binding probes between configured sends preserve the live Thread proof without another resume", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.transport.activeProcessGeneration = 1;
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: params.threadId } };
  };
  const cwd = "/workspace";
  const fullOptions = { cwd, runtimeWorkspaceRoots: [cwd, "/shared"],
    developerInstructions: "session instructions", dynamicToolAgentId: "session-owner",
    config: { tools: true } };
  const commands = createCodexSessionCommands({
    store: { getLogicalSession: () => ({ activeBinding: { bindingId: "binding", boundCwd: cwd } }) },
    codexRuntime: client
  });
  const reference = { sessionId: "session", logicalSessionId: "logical", bindingId: "binding", providerSessionId: "thread" };
  await client.ensureThreadResumed("thread", fullOptions);
  for (let i = 0; i < 2; i++) {
    const probe = await commands.probeCodexProviderBinding(reference);
    assert.equal(probe.threadAlreadyLoaded, true);
    assert.equal((await client.ensureThreadResumed("thread", fullOptions)).alreadyLoaded, true);
  }
  assert.equal(requests.filter(request => request.method === "thread/resume").length, 1);
  assert.equal((await commands.probeCodexProviderBinding(reference, { reconcileOnly: true })).ready, true);
  assert.equal((await client.ensureThreadResumed("thread", fullOptions)).alreadyLoaded, true);
  // Existence is not configuration authorization: a changed Tool context or
  // process generation must still force dispatch to obtain a fresh proof.
  await client.ensureThreadResumed("thread", { ...fullOptions, config: { tools: false } });
  assert.equal(requests.length, 2);
  client.clearGenerationThreadState();
  await client.ensureThreadResumed("thread", fullOptions);
  assert.equal(requests.length, 3);
  await client.ensureThreadResumed("thread", { cwd: "/another-workspace", bindingReadinessProbe: true });
  assert.equal(requests.length, 4);
});

test("existence probe keeps a fresh empty Thread's full Tool context without trying to resume its rollout", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async () => { throw new Error("fresh Thread has no rollout"); };
  const options = { cwd: "/workspace", dynamicToolAgentId: "owner", config: { tools: true } };
  client.bindThreadToolContext("fresh", options);
  client.freshThreadIds.add("fresh");
  const before = client.threadResumeFingerprints.get("fresh");
  assert.equal((await client.ensureThreadResumed("fresh", {
    cwd: "/workspace", bindingReadinessProbe: true
  })).alreadyLoaded, true);
  assert.equal(client.threadResumeFingerprints.get("fresh"), before);
});

test("fresh thread creation, tool finalization and first readiness probe preserve one workspace without rollout resume", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.transport.activeProcessGeneration = 1;
  const calls = [];
  client.request = async method => {
    calls.push(method);
    if (method === "thread/start") return { thread: { id: "fresh" } };
    throw Object.assign(new Error("no rollout found"), { code: "PROVIDER_SESSION_UNAVAILABLE" });
  };
  const session = { id: "session", external: { cwd: "/integration" } };
  const commands = createCodexSessionCommands({
    store: {
      getSession: () => session,
      getLogicalSession: () => ({ activeBinding: { bindingId: "binding", boundCwd: "/integration" } })
    },
    codexRuntime: client,
    withPersistedCodexToolConfirmation: (_reference, options) => options,
    collaborationThreadOptionsForSession: async () => ({ dynamicTools: [] })
  });
  const reference = { sessionId: "session", logicalSessionId: "logical", bindingId: "binding", providerSessionId: "fresh" };
  await client.startThread({ cwd: "/integration", approvalPolicy: "never", sandbox: "danger-full-access" });
  await commands.resumeCodexProviderSession(reference, { purpose: "session-create-finalization" });
  assert.equal((await commands.probeCodexProviderBinding(reference)).ready, true);
  const proof = JSON.parse(client.threadResumeFingerprints.get("fresh"));
  assert.equal(proof.cwd, "/integration");
  assert.equal(proof.approvalPolicy, "never");
  assert.equal(proof.sandbox, "danger-full-access");
  assert.deepEqual(calls, ["thread/start"]);
});

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

test("native no-active-turn response maps to scoped absence, not transport failure", async () => {
  const reference = { providerSessionId: "native", metadata: { session: { external: { activeTurnId: "turn" } } } };
  for (const payload of [
    { code: -32600, message: "no active turn to interrupt" },
    { code: -32603, message: "no active turn to interrupt" },
    { code: -32600, message: "connection failed" }
  ]) {
    const original = new Error(JSON.stringify(payload));
    const commands = createCodexSessionCommands({ codexRuntime: {
      interruptTurn: async () => { throw original; }
    } });
    await assert.rejects(commands.interruptCodexProviderSession(reference), error => {
      if (payload.code === -32600 && payload.message === "no active turn to interrupt") {
        assert.equal(error.code, "PROVIDER_TURN_NOT_ACTIVE");
        assert.equal(error.turnId, "turn");
        assert.equal(error.providerSessionId, "native");
      } else assert.equal(error, original);
      return true;
    });
  }
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
