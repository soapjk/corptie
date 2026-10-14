import test from "node:test";
import assert from "node:assert/strict";
import { createCodexSessionCreator } from "../src/adapters/codexSessionCreator.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

function forkFixture({ lastTurn = { id: "cutoff" }, readError = null } = {}) {
  const calls = [];
  const creator = createCodexSessionCreator({
    collaborationCore: { getAgent: () => ({ agentId: "agent" }) },
    codexRuntime: {
      forkThread: async (id, options) => {
        calls.push(["fork", id, options]);
        return { thread: { id: "fork", cwd: "/target" } };
      },
      readLastThreadTurn: async id => {
        calls.push(["boundary", id]);
        if (readError) throw readError;
        return lastTurn;
      },
      clearThreadGoal: async id => calls.push(["clear-goal", id]),
      archiveThread: async id => calls.push(["archive", id]),
      startThread: async () => assert.fail("must fork the source, not start an empty thread")
    },
    resolvedNewCodexRuntimeConfig: async () => ({ model: "model" }),
    collaborationThreadOptionsWithAgentContext: async () => ({}),
    withPersistedCodexToolConfirmation: (_reference, options) => options,
    codexAppServerSessionCapabilities: () => ({})
  });
  const create = () => creator.create({ title: "Branch", cwd: "/target", toolHost: { actorId: "agent" } }, {
    reference: { providerSessionId: "source" }, point: { turnId: "cutoff" }
  });
  return { calls, create };
}

test("message fork excludes returned history and validates its exact cutoff before publishing", async () => {
  const f = forkFixture();
  const session = await f.create();
  assert.equal(session.id, "codex:fork");
  assert.deepEqual(f.calls.map(call => call[0]), ["fork", "boundary", "clear-goal"]);
  assert.equal(f.calls[0][1], "source");
  assert.equal(f.calls[0][2].lastTurnId, "cutoff");
  assert.equal(f.calls[0][2].excludeTurns, true);
  assert.equal(f.calls[0][2].deferGoalContinuation, true);
  assert.equal(f.calls[1][1], "fork");
});

test("a fork with later history is archived and cannot clear its goal or publish a Session", async () => {
  const f = forkFixture({ lastTurn: { id: "later-turn" } });
  await assert.rejects(f.create(), { code: "FORK_HISTORY_MISMATCH" });
  assert.deepEqual(f.calls.map(call => call[0]), ["fork", "boundary", "archive"]);
  assert.equal(f.calls.at(-1)[1], "fork");
});

test("unavailable boundary proof archives the known fork without retrying native creation", async () => {
  const error = Object.assign(new Error("paging unavailable"), { code: "FORK_HISTORY_UNVERIFIED" });
  const f = forkFixture({ readError: error });
  await assert.rejects(f.create(), error);
  assert.deepEqual(f.calls.map(call => call[0]), ["fork", "boundary", "archive"]);
});

test("boundary inspection requests exactly one Turn with no items and rejects missing proof", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  const requests = [];
  let page = { data: [{ id: "cutoff" }] };
  client.request = async (method, params) => { requests.push({ method, params }); return page; };
  assert.deepEqual(await client.readLastThreadTurn("fork"), { id: "cutoff" });
  assert.deepEqual(requests[0], { method: "thread/turns/list", params: {
    threadId: "fork", limit: 1, sortDirection: "desc", itemsView: "notLoaded"
  } });
  for (const data of [null, [], [{ id: "" }], [{ id: 123 }], [{ id: "cutoff" }, { id: "later" }]]) {
    page = { data };
    await assert.rejects(client.readLastThreadTurn("fork"), { code: "FORK_HISTORY_UNVERIFIED" });
  }
  const error = new Error("unsupported paging");
  client.request = async (method) => { requests.push({ method }); throw error; };
  await assert.rejects(client.readLastThreadTurn("fork"), error);
  assert.ok(requests.every(request => request.method === "thread/turns/list"));
});

test("large-history fork can complete after the ordinary RPC deadline without replay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  let calls = 0;
  client.request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    calls++;
    assert.equal(method, "thread/fork");
    assert.equal(params.lastTurnId, "cutoff");
    const deadline = setTimeout(() => reject(new Error("fork timeout")), timeoutMs);
    setTimeout(() => {
      clearTimeout(deadline);
      resolve({ thread: { id: "fork", cwd: "/target" } });
    }, 33_000);
  });
  const result = client.forkThread("source", { cwd: "/target", lastTurnId: "cutoff" });
  await Promise.resolve();
  t.mock.timers.tick(33_001);
  assert.equal((await result).thread.id, "fork");
  assert.equal(calls, 1);
});

test("fork timeout keeps unknown disposition and explains that remote creation may still finish", async () => {
  let calls = 0;
  const error = Object.assign(new Error("RPC timeout"), {
    code: "PROVIDER_RPC_TIMEOUT", remoteDisposition: "unknown", timeoutMs: 60_000, safeToRetry: false
  });
  const creator = createCodexSessionCreator({
    collaborationCore: { getAgent: () => ({ agentId: "agent" }) },
    codexRuntime: { forkThread: async () => { calls++; throw error; } },
    resolvedNewCodexRuntimeConfig: async () => ({}),
    collaborationThreadOptionsWithAgentContext: async () => ({}),
    withPersistedCodexToolConfirmation: (_reference, options) => options
  });
  await assert.rejects(creator.create({ cwd: "/target", toolHost: { actorId: "agent" } }, {
    reference: { providerSessionId: "source" }, point: { turnId: "cutoff" }
  }), failure => {
    assert.equal(failure, error);
    assert.match(failure.message, /60 秒/);
    assert.match(failure.message, /远端结果尚未确认/);
    assert.equal(failure.safeToRetry, false);
    return true;
  });
  assert.equal(calls, 1);
});

test("creation requires an existing Agent before starting a native thread", async () => {
  const creator = createCodexSessionCreator({
    collaborationCore: { getAgent: () => null },
    codexRuntime: { startThread: () => assert.fail("must not create") }
  });
  await assert.rejects(creator.create({}), { code: "AGENT_REQUIRED" });
  await assert.rejects(creator.create({ toolHost: { actorId: "missing" } }), { code: "AGENT_NOT_FOUND" });
});

test("a fork with the wrong workspace is archived before reporting failure", async () => {
  const calls = [];
  const creator = createCodexSessionCreator({
    collaborationCore: { getAgent: () => ({ agentId: "agent" }) },
    codexRuntime: {
      forkThread: async (id, options) => {
        calls.push(["fork", id, options.lastTurnId]);
        return { thread: { id: "fork", cwd: "/wrong" } };
      },
      archiveThread: async id => calls.push(["archive", id]),
      clearThreadGoal: () => assert.fail("workspace must be validated first")
    },
    resolvedNewCodexRuntimeConfig: async () => ({}),
    collaborationThreadOptionsWithAgentContext: async () => ({}),
    withPersistedCodexToolConfirmation: (_reference, options) => options
  });
  await assert.rejects(creator.create(
    { cwd: "/target", toolHost: { actorId: "agent" } },
    { reference: { providerSessionId: "source" }, point: { turnId: "cutoff" } }
  ), { code: "FORK_CWD_MISMATCH" });
  assert.deepEqual(calls, [["fork", "source", "cutoff"], ["archive", "fork"]]);
});
