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
  readWindow: async () => ({ revision: 4, hasEarlier: false, items: [{ id: "item:1", type: "agentMessage", text: "hello", secret: "private", userMessageStatus: "processing", queuePosition: 2 }] }),
  send: async () => {}, stop: async () => {} };

test("image-only messages and mentions use shared send and deduplicate attachments", async () => {
  const f = await fixture();
  try {
    const imports = [], sends = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      images: { available: () => true, import: async (id, image) => {
        imports.push([id, image]); return { managedPath: "chat-resources/session/image.png", originalPath: null };
      } }, send: async (...args) => sends.push(args) });
    const input = { requestId: "image_request", text: "", images: [{ fileName: "image.png", dataBase64: "aGVsbG8=" }] };
    assert.equal((await api.command(identity, "session:test", "send", input)).status, "accepted");
    await api.command(identity, "session:test", "send", input);
    assert.equal(imports.length, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0][1].images[0].originalPath, null);
    assert.equal(sends[0][2].type, "remote-client");
    await assert.rejects(api.command(identity, "session:test", "send", {
      ...input, images: [{ ...input.images[0], dataBase64: "d29ybGQ=" }]
    }), { code: "IDEMPOTENCY_CONFLICT" });
    for (const images of [[{ sourcePath: "/etc/passwd" }], [{ fileName: "x", dataBase64: "invalid!" }], Array(9).fill(input.images[0])]) {
      await assert.rejects(api.command(identity, "session:test", "send", { ...input, images }), { code: "INVALID_IMAGES" });
    }
    const noImages = new ClientSessionAPI({ store: f.store, ...callbacks });
    await assert.rejects(noImages.command(identity, "session:test", "send", input), { code: "CAPABILITY_UNSUPPORTED" });
    const mention = { targetType: "work", targetId: "work:test", displayName: "Work" };
    await api.command(identity, "session:test", "send", { requestId: "mention_request", text: "@Work hello", mentions: [mention] });
    assert.deepEqual(sends[1][1].mentions, [mention]);
    await assert.rejects(api.command(identity, "session:test", "send", {
      requestId: "invalid_mention", text: "hello", mentions: [{ ...mention, targetType: "agent" }]
    }), { code: "INVALID_MENTIONS" });
  } finally { await f.close(); }
});

test("scheduled messages are scoped and deduplicated without immediate model sends", async () => {
  const f = await fixture();
  try {
    const scheduled = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      send: async () => assert.fail("scheduled message must not send now"),
      schedule: async (...args) => scheduled.push(args) });
    const schedule = { runAt: new Date(Date.now() + 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const input = { requestId: "schedule_request", text: "later", schedule };
    assert.equal((await api.command(identity, "session:test", "send", input)).status, "accepted");
    await api.command(identity, "session:test", "send", input);
    assert.deepEqual(scheduled, [["session:test", "later", schedule, identity]]);
    for (const bad of [{ ...schedule, process: { pid: 1 } }, { ...schedule, intervalSeconds: 0 }, { ...schedule, runAt: "invalid" }]) {
      await assert.rejects(api.command(identity, "session:test", "send", { ...input, schedule: bad }), { code: "INVALID_SCHEDULE" });
    }
    await assert.rejects(api.command({ ...identity, permissions: [] }, "session:test", "send", input), { code: "DEVICE_PERMISSION_REQUIRED" });
    assert.equal(scheduled.length, 1);
  } finally { await f.close(); }
});

test("composer configuration resolves Session identity, checks permissions and uses neutral callbacks", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      resolveSession: id => id === "logical:test" ? "session:test" : id,
      actions: () => ({ switchModel: { available: true }, switchReasoning: { available: false } }),
      composer: {
        read: async id => ({ currentModel: "model:test", models: [{ id: "model:test", name: "Test", secret: "private" }] }),
        update: async (...args) => calls.push(args)
      } });
    const result = await api.configuration(identity, "logical:test", { model: "model:test" });
    assert.equal(result.sessionId, "session:test");
    assert.equal(result.currentModel, "model:test");
    assert.equal(Object.hasOwn(result.models[0], "secret"), false);
    assert.deepEqual(calls, [["session:test", "model", "model:test"]]);
    await assert.rejects(api.configuration({ ...identity, permissions: ["messages.read"] }, "session:test", { model: "x" }), { code: "DEVICE_PERMISSION_REQUIRED" });
    await assert.rejects(api.configuration(identity, "session:test", { reasoningLevel: "high" }), { code: "CAPABILITY_UNSUPPORTED" });
    for (const input of [{}, [], { model: "x", source: "admin" }, { provider: "x" }, { model: "" }]) {
      await assert.rejects(api.configuration(identity, "session:test", input), { code: "INVALID_CONFIGURATION" });
    }
    assert.equal(calls.length, 1);
  } finally { await f.close(); }
});

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
    assert.equal(page.items[0].userMessageStatus, "processing");
    assert.equal(page.items[0].queuePosition, 2);
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

test("stable logical Session ids resolve to the current executable Session", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const api = new ClientSessionAPI({ store: f.store, ...callbacks,
      resolveSession: id => id === "logical:test" ? "session:test" : id,
      readWindow: async id => {
        calls.push(id);
        return { revision: 1, hasEarlier: false, items: [] };
      },
      send: async id => { calls.push(id); } });
    const page = await api.messages(identity, "logical:test", new URLSearchParams());
    assert.equal(page.sessionId, "session:test");
    assert.equal(api.capabilities(identity, "logical:test").sessionId, "session:test");
    const receipt = await api.command(identity, "logical:test", "send",
      { requestId: "logical_request", text: "Hello" });
    assert.equal(receipt.sessionId, "session:test");
    assert.deepEqual(calls, ["session:test", "session:test"]);
  } finally { await f.close(); }
});
