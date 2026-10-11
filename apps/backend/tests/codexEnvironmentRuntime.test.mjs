import test from "node:test";
import assert from "node:assert/strict";
import { createCodexEnvironmentRuntime } from "../src/agent-provider/bootstrap/codexEnvironmentRuntime.mjs";

test("executable transition blocks new work and rejects every busy runtime state", async t => {
  const profile = { profileId: "native", mode: "native" };
  const client = { freshThreadIds: new Set(), transport: { pending: new Map() },
    serverRequestsByThread: new Map(), threadResumePromises: new Map(), recoveryStabilizationThreads: new Set() };
  let notify;
  const runtime = createCodexEnvironmentRuntime({ registry: { current: profile },
    environment: () => ({}), prepare: async () => {}, instructions: async () => "",
    createRuntime: options => { notify = options.onNotification; return { client, close: async () => {} }; } });
  t.after(() => runtime.close());
  runtime.runtimeFor(profile);
  for (const pending of [client.freshThreadIds, client.transport.pending, client.serverRequestsByThread,
    client.threadResumePromises, client.recoveryStabilizationThreads]) {
    if (pending instanceof Map) pending.set("busy", {}); else pending.add("busy");
    await assert.rejects(runtime.withExecutableTransition(async () => assert.fail("must not switch")), /正在执行/);
    pending.clear();
  }
  notify({ method: "turn/started", params: { turn: { id: "turn" } } });
  assert.throws(() => runtime.assertExecutableChangeAllowed(), /正在执行/);
  notify({ method: "turn/completed", params: { turn: { id: "turn" } } });
  await runtime.withExecutableTransition(async () => {
    assert.throws(() => runtime.runtimeFor(profile), { code: "PROVIDER_BUSY" });
    await assert.rejects(runtime.startThread({}), { code: "PROVIDER_BUSY" });
  });
  runtime.assertExecutableChangeAllowed();
  await assert.rejects(runtime.withExecutableTransition(async () => { throw new Error("rollback"); }), /rollback/);
  runtime.assertExecutableChangeAllowed();
});

function fixture(options = {}) {
  const isolated = { profileId: "old", mode: "isolated", home: "/old" };
  const native = { profileId: "new", mode: "native", home: "/native" };
  const threads = new Map(); const calls = []; const prepared = []; const clients = [];
  const registry = { current: isolated, forThread: id => threads.get(id) ?? isolated,
    register: async (profile, { threadId }) => threads.set(threadId, profile) };
  let sequence = 0;
  const runtime = createCodexEnvironmentRuntime({ registry,
    environment: profile => ({ CODEX_HOME: profile.home }),
    prepare: async profile => { prepared.push(profile.profileId); },
    instructions: async () => "Corptie scoped instructions", ...options,
    createRuntime: config => {
      clients.push(config);
      return new Proxy({ notifications: [], close: async () => {} }, { get(target, method) {
        if (method in target) return target[method];
        return async (...args) => {
          calls.push({ method, home: config.env().CODEX_HOME, args });
          if (["startThread", "forkThread"].includes(method)) return { thread: { id: `thread-${++sequence}` } };
          return { ok: true };
        };
      } });
    }
  });
  return { runtime, registry, isolated, native, calls, prepared, clients, threads };
}

test("start, resume, turn, fork and approvals route through persisted Home", async t => {
  const f = fixture(); t.after(() => f.runtime.close());
  const old = await f.runtime.startThread({ developerInstructions: "original" });
  f.registry.current = f.native;
  const current = await f.runtime.startThread({ developerInstructions: "original" });
  await f.runtime.resumeThread(old.thread.id, {});
  await f.runtime.startTurn(old.thread.id, "old-message", {});
  await f.runtime.respondToApproval(current.thread.id, {});
  const fork = await f.runtime.forkThread(old.thread.id, {});
  await f.runtime.startTurn(fork.thread.id, "fork", {});
  assert.deepEqual(f.calls.map(call => call.home), ["/old", "/native", "/old", "/old", "/native", "/old", "/old"]);
  assert.equal(f.calls[0].args[0].developerInstructions, "original");
  assert.equal(f.calls[1].args[0].developerInstructions, "Corptie scoped instructions\n\noriginal");
  assert.deepEqual(f.prepared, ["old", "new"]);
});

test("native resume receives scoped instructions without overwriting user Home", async t => {
  const f = fixture(); t.after(() => f.runtime.close()); f.registry.current = f.native;
  const { thread } = await f.runtime.startThread({});
  await f.runtime.ensureThreadResumed(thread.id, { developerInstructions: "tool-host" });
  assert.equal(f.calls.at(-1).args[1].developerInstructions, "Corptie scoped instructions\n\ntool-host");
  assert.equal(f.clients.length, 1);
});

test("no-tools background operations do not inherit Corptie tool instructions", async t => {
  const f = fixture(); t.after(() => f.runtime.close()); f.registry.current = f.native;
  await f.runtime.runEphemeralPrompt({ executionPolicy: "no-tools", developerInstructions: "transform only" });
  assert.equal(f.calls[0].args[0].developerInstructions, "transform only");
});

test("bounded pool refuses another environment without closing active threads", async t => {
  const f = fixture({ maxEnvironments: 1 }); t.after(() => f.runtime.close());
  await f.runtime.startThread({}); f.registry.current = f.native;
  await assert.rejects(f.runtime.startThread({}), { code: "PROVIDER_ENVIRONMENT_LIMIT" });
  assert.equal(f.clients.length, 1);
});

test("clear, recovery and handoff replacements retain their source environment", async t => {
  const f = fixture({ resolveSourceThread: input => input.dynamicToolMetadata?.sourceThread });
  t.after(() => f.runtime.close());
  const original = await f.runtime.startThread({});
  f.registry.current = f.native;
  const clear = await f.runtime.startThread({ sourceThreadId: original.thread.id });
  const recovery = await f.runtime.startThread({ dynamicToolMetadata: { sourceThread: original.thread.id } });
  await f.runtime.readAccountRateLimits(original.thread.id);
  assert.equal(f.threads.get(clear.thread.id).mode, "isolated");
  assert.equal(f.threads.get(recovery.thread.id).mode, "isolated");
  assert.ok(f.calls.every(call => call.home === "/old"));
});

test("binding persistence failure never publishes the new provider thread", async t => {
  const f = fixture(); t.after(() => f.runtime.close());
  f.registry.register = async () => { throw new Error("disk full"); };
  await assert.rejects(f.runtime.startThread({}), /disk full/);
  assert.equal(f.calls.at(-1).method, "archiveThread");
});
