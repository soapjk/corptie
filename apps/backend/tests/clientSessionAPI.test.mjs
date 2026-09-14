import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

const identity = { deviceId: "device:one", permissions: ["inventory.read", "messages.read", "messages.write", "sessions.stop"] };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-client-command-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createSession({ id: "session:test", title: "Test", sessionKind: "assistantChat", status: "complete" });
  return { store, close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const callbacks = { actions: () => ({ send: { available: true }, interrupt: { available: true } }),
  readWindow: async () => ({ revision: 4, hasEarlier: false, items: [{ id: "item:1", type: "agentMessage", text: "hello", secret: "private" }] }),
  send: async () => {}, stop: async () => {} };

test("commands dispatch once, replay durable receipt and reject changed payload", async () => {
  const f = await fixture();
  try {
    let sends = 0;
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, send: async () => { sends++; } });
    const input = { requestId: "request_123", text: "Hello" };
    const results = await Promise.all([api.command(identity, "session:test", "send", input), api.command(identity, "session:test", "send", input)]);
    assert.equal(sends, 1);
    assert.ok(results.some(r => r.status === "accepted"));
    const restarted = new ClientSessionAPI({ store: f.store, ...callbacks, send: async () => { sends++; } });
    assert.equal((await restarted.command(identity, "session:test", "send", input)).status, "accepted");
    assert.equal(sends, 1);
    await assert.rejects(api.command(identity, "session:test", "send", { ...input, text: "changed" }), { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => api.receipt({ ...identity, deviceId: "another" }, input.requestId), { code: "COMMAND_NOT_FOUND" });
    let stops = 0;
    const stopping = new ClientSessionAPI({ store: f.store, ...callbacks, stop: async () => { stops++; } });
    const stop = { requestId: "stop_12345" };
    assert.equal((await stopping.command(identity, "session:test", "stop", stop)).status, "stop_requested");
    await stopping.command(identity, "session:test", "stop", stop);
    assert.equal(stops, 1);
  } finally { await f.close(); }
});

test("permissions, provider capabilities and payload boundaries precede execution", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    for (const provider of ["codex", "claude", "openclacky", "future-provider"]) {
      const api = new ClientSessionAPI({ store: f.store, ...callbacks,
        actions: () => ({ send: { available: false, reason: "CAPABILITY_UNSUPPORTED" } }), send: async () => { calls++; } });
      await assert.rejects(api.command(identity, "session:test", "send", { requestId: `request_${provider}`, text: "test" }), { code: "CAPABILITY_UNSUPPORTED" });
    }
    const api = new ClientSessionAPI({ store: f.store, ...callbacks });
    await assert.rejects(api.command({ ...identity, permissions: ["inventory.read"] }, "session:test", "send", { requestId: "request_123", text: "test" }), { code: "DEVICE_PERMISSION_REQUIRED" });
    for (const text of ["", "/clear", "a".repeat(16001)]) {
      await assert.rejects(api.command(identity, "session:test", "send", { requestId: "request_123", text }), { code: "INVALID_MESSAGE" });
    }
    await assert.rejects(api.command(identity, "session:test", "send", { requestId: "request_123", text: "test", source: { type: "agent" } }), { code: "INVALID_COMMAND" });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test("uncertain dispatch is never automatically replayed; reads project only public message fields", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const api = new ClientSessionAPI({ store: f.store, ...callbacks, send: async () => { calls++; throw new Error("secret provider detail"); } });
    const input = { requestId: "request_123", text: "test" };
    assert.equal((await api.command(identity, "session:test", "send", input)).status, "unknown");
    await api.command(identity, "session:test", "send", input);
    assert.equal(calls, 1);
    const page = await api.messages(identity, "session:test", new URLSearchParams());
    assert.equal(page.items[0].text, "hello");
    assert.equal(Object.hasOwn(page.items[0], "secret"), false);
    const history = new ClientSessionAPI({ store: f.store, ...callbacks, readWindow: async () => ({
      revision: 5, hasEarlier: true, items: ["older", "previous", "anchor", "newer"].map(id => ({ id, type: "userMessage", text: id }))
    }) });
    const older = await history.messages(identity, "session:test", new URLSearchParams("before=anchor&limit=2"));
    assert.deepEqual(older.items.map(item => item.id), ["older", "previous"]);
    assert.equal(older.nextBefore, "older");
    await assert.rejects(api.messages(identity, "session:test", new URLSearchParams("before=missing")), { code: "ANCHOR_NOT_FOUND" });
    await assert.rejects(api.messages(identity, "session:test", new URLSearchParams("limit=100")), { code: "INVALID_LIMIT" });
    await assert.rejects(api.messages({ ...identity, permissions: [] }, "session:test", new URLSearchParams()), { code: "DEVICE_PERMISSION_REQUIRED" });
  } finally { await f.close(); }
});
