import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexStdioTransport } from "../src/adapters/codexStdioTransport.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.requests = [];
  child.kill = () => { child.killed = true; };
  child.stdin.on("data", (data) => {
    for (const line of String(data).trim().split("\n")) {
      const message = JSON.parse(line);
      child.requests.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({
          id: message.id, result: { userAgent: "test-runtime" }
        }) + "\n"));
      }
    }
  });
  return child;
}

test("runtime validates the exact command before spawn and after handshake", async () => {
  const child = fakeChild();
  const events = [];
  const transport = new CodexStdioTransport({ command: () => "/chosen/codex",
    validateCommand: async path => events.push(["validate", path]),
    spawnProcess: path => { events.push(["spawn", path]); return child; } });
  await transport.initialize();
  assert.deepEqual(events, [["validate", "/chosen/codex"], ["spawn", "/chosen/codex"], ["validate", "/chosen/codex"]]);
  assert.equal(transport.runningCommand, "/chosen/codex");
  await transport.close();
  assert.equal(transport.runningCommand, null);
  const changed = new CodexStdioTransport({ validateCommand: () => { throw new Error("binary changed"); },
    spawnProcess: () => { throw new Error("must not spawn"); } });
  await assert.rejects(changed.initialize(), /binary changed/);
});

test("initialize acknowledgement enables notifications before commands and repeats only on reconnect", async () => {
  const child = fakeChild();
  const received = [];
  child.stdin.on("data", data => {
    for (const line of String(data).trim().split("\n")) {
      if (JSON.parse(line).method === "initialized") {
        child.stdout.write(JSON.stringify({ method: "error", params: {
          threadId: "thread", turnId: "turn", willRetry: true,
          error: { message: "high demand" }
        } }) + "\n");
      }
    }
  });
  const transport = new CodexStdioTransport({ spawnProcess: () => child, onNotification: value => received.push(value) });
  try {
    await Promise.all([transport.initialize(), transport.initialize()]);
    assert.deepEqual(child.requests.map(value => value.method), ["initialize", "initialized"]);
    assert.equal(Object.hasOwn(child.requests[1], "id"), false, "initialized is a notification, not an RPC");
    assert.equal(received[0].params.error.message, "high demand");
    await transport.initialize();
    assert.equal(child.requests.length, 2);
    await transport.close();
    await transport.initialize();
    assert.deepEqual(child.requests.map(value => value.method), ["initialize", "initialized", "initialize", "initialized"]);
  } finally { await transport.close(); }
});

test("RPC responses correlate independently from native requests and notifications", async () => {
  const child = fakeChild();
  const notifications = [], requests = [], diagnostics = [];
  const transport = new CodexStdioTransport({
    spawnProcess: () => child,
    onNotification: (value) => notifications.push(value),
    onServerRequest: (value) => requests.push(value),
    onDiagnostic: (value) => diagnostics.push(value)
  });
  try {
    await transport.initialize();
    const pending = transport.request("thread/read", { threadId: "thread:1" });
    const id = child.requests.at(-1).id;
    transport.handleLine(JSON.stringify({ id: 99, method: "item/tool/call", params: {} }));
    transport.handleLine(JSON.stringify({ method: "turn/started", params: {} }));
    transport.handleLine("invalid-json");
    transport.handleLine(JSON.stringify({ id, result: { thread: "thread:1" } }));
    assert.deepEqual(await pending, { thread: "thread:1" });
    assert.equal(transport.pending.size, 0);
    assert.equal(requests[0].id, 99);
    assert.equal(notifications[0].method, "turn/started");
    assert.equal(diagnostics[0].method, "parseError");
    assert.equal(transport.runtimeUserAgent, "test-runtime");
  } finally {
    await transport.close();
  }
});

test("close expires interactions before rejecting RPCs and clearing generation state", async () => {
  const child = fakeChild();
  const observations = [];
  const transport = new CodexStdioTransport({
    spawnProcess: () => child,
    onBeforeClear: () => observations.push(["before", transport.pending.size, transport.process === child]),
    onCleared: () => observations.push(["after", transport.pending.size, transport.process])
  });
  await transport.initialize();
  const pending = transport.request("thread/read", {});
  const rejection = assert.rejects(pending, /closed before response/);
  await transport.close();
  await rejection;
  assert.deepEqual(observations, [["before", 1, true], ["after", 0, null]]);
  assert.equal(child.killed, true);
  assert.equal(transport.initializePromise, null);
});

test("timeout removes only its pending RPC and late responses are ignored", async () => {
  const child = fakeChild();
  const transport = new CodexStdioTransport({ spawnProcess: () => child });
  try {
    await transport.initialize();
    const expired = transport.request("slow", {}, 5);
    const expiredID = child.requests.at(-1).id;
    const active = transport.request("active", {});
    const activeID = child.requests.at(-1).id;
    await assert.rejects(expired, /request timed out: slow/);
    assert.equal(transport.pending.size, 1);
    transport.handleLine(JSON.stringify({ id: expiredID, result: "late" }));
    assert.equal(transport.pending.size, 1);
    transport.handleLine(JSON.stringify({ id: activeID, result: "current" }));
    assert.equal(await active, "current");
  } finally {
    await transport.close();
  }
});

test("response normalization retains the safe missing-session recovery classification", async () => {
  const child = fakeChild();
  const transport = new CodexStdioTransport({ spawnProcess: () => child });
  try {
    await transport.initialize();
    const pending = transport.request("thread/resume", {});
    const rejection = assert.rejects(pending, {
      code: "PROVIDER_SESSION_UNAVAILABLE", safeToRetry: true
    });
    transport.handleLine(JSON.stringify({
      id: child.requests.at(-1).id,
      error: { message: "no rollout found for thread id thread:missing" }
    }));
    await rejection;
    assert.equal(transport.pending.size, 0);
  } finally {
    await transport.close();
  }
});

test("sent RPC timeout reports unknown remote outcome without payload or replay", async () => {
  const child = fakeChild();
  const transport = new CodexStdioTransport({ spawnProcess: () => child });
  try {
    await transport.initialize();
    const promise = transport.request("turn/start", { secret: "private-input" }, 5);
    const request = child.requests.at(-1);
    await assert.rejects(promise, error => {
      assert.equal(error.code, "PROVIDER_RPC_TIMEOUT");
      assert.equal(error.requestId, request.id);
      assert.equal(error.method, "turn/start");
      assert.equal(error.processGeneration, transport.activeProcessGeneration);
      assert.equal(error.requestWritten, true);
      assert.equal(error.remoteDisposition, "unknown");
      assert.equal(error.safeToRetry, false);
      assert.equal(error.timeoutMs, 5);
      assert.ok(error.elapsedMs >= 0);
      assert.ok(!JSON.stringify(error).includes("private-input"));
      return true;
    });
    transport.handleLine(JSON.stringify({ id: request.id, result: { accepted: true } }));
    assert.equal(transport.pending.size, 0);
    assert.equal(child.requests.filter(value => value.method === "turn/start").length, 1);
  } finally {
    await transport.close();
  }
});

test("serialization and synchronous write failures release pending RPC timers", async () => {
  const child = fakeChild();
  const transport = new CodexStdioTransport({ spawnProcess: () => child });
  try {
    await transport.initialize();
    const circular = {}; circular.self = circular;
    await assert.rejects(transport.request("thread/read", circular), /circular/i);
    assert.equal(transport.pending.size, 0);
    child.stdin.write = () => { throw new Error("write failure"); };
    await assert.rejects(transport.request("thread/read", {}), /write failure/);
    assert.equal(transport.pending.size, 0);
  } finally {
    await transport.close();
  }
});

test("cold resume has its own budget and preserves explicit caller overrides", async () => {
  for (const [configuration, requested, expected] of [
    [{}, undefined, 60000], [{ threadResumeTimeoutMs: 45000 }, undefined, 45000],
    [{}, 12, 12]
  ]) {
    const client = new CodexAppServerClient(configuration);
    client.initialize = async () => {};
    client.requireThreadToolPlanConfirmation = () => {};
    client.request = async (method, params, timeout) => {
      assert.equal(method, "thread/resume");
      assert.equal(params.threadId, "thread:test");
      assert.equal(timeout, expected);
      return { thread: { id: params.threadId } };
    };
    await client.resumeThread("thread:test", { requestTimeoutMs: requested });
    assert.equal(client.requestTimeoutMs, 8000);
    assert.equal(client.transport.initializationTimeoutMs, 30000);
  }
});

test("late same-generation resume proof reconciles without resurrecting Promise or repeating RPC", async () => {
  const child = fakeChild();
  const metrics = [];
  const client = new CodexAppServerClient({ spawnProcess: () => child, onResumeMetrics: value => metrics.push(value) });
  client.requireThreadToolPlanConfirmation = () => {};
  try {
    await assert.rejects(client.resumeThread("thread", { requestTimeoutMs: 5 }), { code: "PROVIDER_RPC_TIMEOUT" });
    const request = child.requests.at(-1);
    assert.equal(client.inspectThreadResume("thread").ready, false);
    assert.equal(client.inspectThreadResume("thread").canRetryVerification, false);
    await assert.rejects(client.ensureThreadResumed("thread"), { code: "PROVIDER_RESUME_OUTCOME_UNKNOWN" });
    assert.equal(child.requests.filter(value => value.method === "thread/resume").length, 1);
    client.transport.handleLine(JSON.stringify({ id: request.id, result: { privateHistory: "must-not-emit" } }));
    assert.equal(metrics[0].late, true);
    // The rejected Promise and late flag prove timeout; millisecond timers may
    // fire slightly before the nominal interval on the monotonic clock.
    assert.ok(metrics[0].responseBytes > 0 && metrics[0].parseMs >= 0 && metrics[0].totalMs >= 0);
    assert.equal(JSON.stringify(metrics).includes("must-not-emit"), false);
    assert.equal(client.inspectThreadResume("thread").ready, true);
    assert.equal((await client.ensureThreadResumed("thread")).alreadyLoaded, true);
    assert.equal(child.requests.filter(value => value.method === "thread/resume").length, 1);
    assert.equal(client.inspectThreadResume("thread", { model: "changed" }).ready, false);
    assert.equal(client.inspectThreadResume("thread", { model: "changed" }).canRetryVerification, true);
    await client.close();
    assert.equal(client.inspectThreadResume("thread").ready, false);
    assert.equal(client.inspectThreadResume("thread").canRetryVerification, true);
  } finally {
    await client.close();
  }
});

test("resume response metrics are bounded and diagnostics cannot reject a successful RPC", async () => {
  const child = fakeChild();
  const metrics = [];
  const transport = new CodexStdioTransport({ spawnProcess: () => child,
    onResumeMetrics: value => { metrics.push(value); throw Error("diagnostics unavailable"); } });
  try {
    await transport.initialize();
    const pending = transport.request("thread/resume", { threadId: "thread", excludeTurns: true });
    const result = { thread: { id: "thread", turns: [] } };
    const line = JSON.stringify({ id: child.requests.at(-1).id, result });
    transport.handleLine(line);
    assert.deepEqual(await pending, result);
    assert.equal(metrics[0].responseBytes, Buffer.byteLength(line));
    assert.equal(metrics[0].threadId, "thread");
    assert.equal(metrics[0].late, false);
    assert.equal(Object.hasOwn(metrics[0], "result"), false);
  } finally { await transport.close(); }
});

test("expired resume tombstones do not publish proof or clear unknown outcomes", async () => {
  const child = fakeChild();
  const proofs = [];
  const transport = new CodexStdioTransport({ spawnProcess: () => child,
    onLateResumeResponse: proof => proofs.push(proof) });
  try {
    await transport.initialize();
    await assert.rejects(transport.request("thread/resume", {}, 5));
    const id = child.requests.at(-1).id;
    transport.resumeTombstones.get(id).expiresAt = 0;
    transport.handleLine(JSON.stringify({ id, result: "private" }));
    assert.deepEqual(proofs, []);
    assert.equal(transport.resumeTombstones.size, 0);
  } finally { await transport.close(); }
});

test("late proof binds exact host Tool identity and cannot revive a released thread", async () => {
  const child = fakeChild();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  client.requireThreadToolPlanConfirmation = () => {};
  const options = { dynamicToolAgentId: "agent", dynamicToolMetadata: { bindingId: "binding" }, requestTimeoutMs: 5 };
  try {
    await assert.rejects(client.resumeThread("thread", options));
    client.transport.handleLine(JSON.stringify({ id: child.requests.at(-1).id, result: {} }));
    assert.equal(client.dynamicToolAgentsByThread.get("thread"), "agent");
    assert.deepEqual(client.dynamicToolMetadataByThread.get("thread"), { bindingId: "binding" });
    await assert.rejects(client.resumeThread("released", options));
    const id = child.requests.at(-1).id;
    client.releaseThreadRuntimeState("released");
    client.transport.handleLine(JSON.stringify({ id, result: {} }));
    assert.equal(client.inspectThreadResume("released", options).ready, false);
    assert.equal(client.dynamicToolAgentsByThread.has("released"), false);
  } finally { await client.close(); }
});
