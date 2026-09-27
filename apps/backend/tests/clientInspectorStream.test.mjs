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
