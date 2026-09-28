import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexStdioTransport } from "../src/adapters/codexStdioTransport.mjs";

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
