import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ClientInspectorStream } from "../src/application/clientInspectorStream.mjs";

class Response extends EventEmitter {
  frames = []; writableLength = 0; writableNeedDrain = false; destroyed = false;
  writeHead(status) { this.status = status; }
  write(frame) { this.frames.push(frame); return !this.writableNeedDrain; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
const auth = () => ({ deviceId: "a" });
test("visible-only snapshots coalesce, suppress unchanged frames, and stop on close", async () => {
  let reads = 0, revision = 1;
  const stream = new ClientInspectorStream({ snapshot: async () => { reads++; return { revision }; }, coalesceMs: 5 });
  stream.invalidate(); await delay(15); assert.equal(reads, 0);
  const response = new Response(); stream.attach(response, auth, "s");
  try {
    await delay(10); assert.equal(response.frames.length, 1);
    for (let i = 0; i < 20; i++) stream.invalidate();
    await delay(20); assert.equal(reads, 2); assert.equal(response.frames.length, 1);
    revision++; stream.invalidate(); await delay(20); assert.equal(response.frames.length, 2);
  } finally { response.destroy(); }
  const previous = reads; stream.invalidate(); await delay(15); assert.equal(reads, previous);
});
test("backpressure isolates a slow device and preserves its latest invalidation", async () => {
  const calls = { slow: 0, fast: 0 };
  const stream = new ClientInspectorStream({ snapshot: async (_, id) => ({ n: ++calls[id] }), coalesceMs: 5 });
  const slow = new Response(), fast = new Response(); slow.writableNeedDrain = true;
  stream.attach(slow, auth, "slow"); stream.attach(fast, () => ({ deviceId: "b" }), "fast");
  try {
    await delay(10); stream.invalidate(); await delay(20);
    assert.equal(calls.slow, 1); assert.equal(calls.fast, 2);
    slow.writableNeedDrain = false; slow.emit("drain"); await delay(20);
    assert.equal(calls.slow, 2);
    assert.throws(() => stream.attach(new Response(), auth, "other"), { code: "INSPECTOR_STREAM_LIMIT" });
  } finally { slow.destroy(); fast.destroy(); }
});
test("authentication is rechecked after asynchronous projection and before sending", async () => {
  let allowed = true, release;
  const stream = new ClientInspectorStream({ snapshot: () => new Promise(resolve => { release = resolve; }) });
  const response = new Response();
  stream.attach(response, () => { if (!allowed) throw new Error("revoked"); return auth(); }, "s");
  allowed = false; release({ secret: true }); await delay(10);
  assert.equal(response.frames.length, 0); assert.equal(response.destroyed, true); assert.equal(stream.clients.size, 0);
});
test("terminal scope errors close the stream using service status", async () => {
  const stream = new ClientInspectorStream({ snapshot: async () => { throw Object.assign(new Error(), { code: "SESSION_NOT_FOUND", status: 404 }); } });
  const response = new Response(); stream.attach(response, auth, "missing"); await delay(10);
  assert.equal(response.destroyed, true); assert.match(response.frames[0], /SESSION_NOT_FOUND/);
});
test("blocked clients skip heartbeats, coalesce invalidations, and still detect revoked credentials", async () => {
  let reads = 0, allowed = true;
  const stream = new ClientInspectorStream({ snapshot: () => ({ revision: ++reads }), coalesceMs: 1, heartbeatMs: 5 });
  const response = new Response(); response.writableNeedDrain = true;
  stream.attach(response, () => { if (!allowed) throw new Error("revoked"); return auth(); }, "s");
  try {
    await delay(10);
    for (let i = 0; i < 100; i++) stream.invalidate();
    await delay(20);
    assert.equal(reads, 1); assert.equal(response.frames.length, 1);
    allowed = false; await delay(20);
    assert.equal(response.destroyed, true); assert.equal(stream.clients.size, 0);
    assert.equal(response.listenerCount("drain"), 0);
  } finally { response.destroy(); }
});
test("trusted per-client sync and Promise snapshots isolate profiles and event baselines while legacy defaults remain", async () => {
  let revision = 1, defaults = 0;
  const stream = new ClientInspectorStream({ snapshot: function (_, id) {
    assert.equal(this, stream); defaults++; return { profile: "legacy", id, revision };
  }, coalesceMs: 1 });
  const responses = [new Response(), new Response(), new Response()];
  const eventForSnapshot = (previous, next) => {
    if (previous) assert.equal(previous.profile, next.profile);
    return { name: previous ? "commit" : "snapshot", value: { profile: next.profile, revision: next.revision } };
  };
  try {
    stream.attach(responses[0], auth, "s", null, { snapshot: (identity, id) => {
      assert.equal(identity.deviceId, "a"); assert.equal(id, "s"); return { profile: "rich-a", revision };
    }, eventForSnapshot });
    const options = { snapshot: async () => ({ profile: "rich-b", revision }), eventForSnapshot };
    stream.attach(responses[1], () => ({ deviceId: "b" }), "s", null, options);
    options.snapshot = () => { throw new Error("mutated host options"); };
    stream.attach(responses[2], () => ({ deviceId: "c" }), "s");
    await delay(10); revision++; stream.invalidate(); await delay(10);
    assert.equal(defaults, 2);
    assert.match(responses[0].frames[1], /event: commit.*\n.*rich-a/);
    assert.match(responses[1].frames[1], /event: commit.*\n.*rich-b/);
    assert.match(responses[2].frames[1], /event: inspector-snapshot.*\n.*legacy/);
  } finally { for (const response of responses) response.destroy(); }
});
test("closed or revoked late snapshots never generate events or advance client previous/hash", async () => {
  for (const reason of ["close", "revoke", "write-revoke"]) {
    let release, allowed = true, events = 0;
    const response = new Response();
    const stream = new ClientInspectorStream({ snapshot: () => assert.fail("must use injected snapshot") });
    stream.attach(response, () => { if (!allowed) throw new Error("revoked"); return auth(); }, "s", null, {
      snapshot: () => new Promise(resolve => { release = resolve; }),
      eventForSnapshot: (_, value) => {
        events++; if (reason === "write-revoke") allowed = false;
        return { name: "snapshot", value };
      }
    });
    const client = [...stream.clients][0];
    if (reason === "close") response.destroy();
    if (reason === "revoke") allowed = false;
    release({ secret: "late" }); await delay(5);
    assert.equal(events, reason === "write-revoke" ? 1 : 0);
    assert.equal(response.frames.length, 0); assert.equal(client.previous, undefined); assert.equal(client.hash, undefined);
    assert.equal(response.destroyed, true); assert.equal(stream.clients.size, 0);
  }
});
test("injected snapshots retain backpressure, coalescing and frame limits", async () => {
  let revision = 1, reads = 0;
  const response = new Response(); response.writableNeedDrain = true;
  const stream = new ClientInspectorStream({ snapshot: () => assert.fail("unexpected legacy read"), coalesceMs: 1, maxFrameBytes: 180 });
  stream.attach(response, auth, "s", null, { snapshot: () => { reads++; return { revision }; } });
  const client = [...stream.clients][0];
  await delay(5); revision++; for (let i = 0; i < 50; i++) stream.invalidate();
  await delay(5); assert.equal(reads, 1);
  response.writableNeedDrain = false; response.emit("drain"); await delay(10);
  assert.equal(reads, 2); assert.equal(client.previous.revision, 2);
  const previous = client.previous, hash = client.hash;
  response.writableLength = 180; revision++; stream.invalidate(); await delay(5);
  assert.equal(response.destroyed, true); assert.equal(client.previous, previous); assert.equal(client.hash, hash);
});
test("injected snapshot failures preserve error semantics and invalid injection fails before headers", async () => {
  const stream = new ClientInspectorStream({ snapshot: () => ({ revision: 1 }) });
  const invalid = new Response();
  assert.throws(() => stream.attach(invalid, auth, "s", null, { snapshot: "wire-controlled" }), { code: "INVALID_INSPECTOR_SNAPSHOT" });
  assert.equal(invalid.status, undefined);
  const response = new Response();
  stream.attach(response, auth, "s", null, { snapshot: async () => { throw Object.assign(new Error(), { status: 404, code: "SESSION_NOT_FOUND" }); } });
  const client = [...stream.clients][0]; await delay(5);
  assert.match(response.frames[0], /SESSION_NOT_FOUND/); assert.equal(response.destroyed, true);
  assert.equal(client.previous, undefined); assert.equal(client.hash, undefined);
});
