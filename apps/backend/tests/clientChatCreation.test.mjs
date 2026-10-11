import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-chat-create-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createAgent({ id: "agent:test", name: "Test" });
  const calls = [];
  const chatCreation = {
    options: () => ({ defaultProviderId: "provider:a", providers: [
      { id: "provider:a", name: "A", available: true },
      { id: "provider:b", name: "B", available: true },
      { id: "provider:disabled", name: "Disabled", available: false }] }),
    create: async input => { calls.push(input); return { id: `session:${calls.length}`, title: input.title, cwd: "PRIVATE" }; }
  };
  const api = new ClientSessionAPI({ store, chatCreation });
  return { api, calls, chatCreation, store,
    close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const identity = { deviceId: "device:test" };
const input = { requestId: "chat-create-001", title: "New Chat", agentId: "agent:test", providerId: "provider:a" };

test("Chat creation exposes resources and is Provider-neutral, receipt-backed and replay-safe", async () => {
  const f = await fixture();
  try {
    const options = await f.api.chatCreationOptions();
    assert.equal(options.schemaVersion, 1);
    assert.ok(options.agents.some(agent => agent.id === "agent:test" && agent.name === "Test"));
    for (const providerId of ["provider:a", "provider:b"]) {
      const body = { ...input, providerId, requestId: `chat-create-${providerId.slice(-1)}` };
      const receipt = await f.api.createChat(identity, body);
      assert.equal(receipt.kind, "chat_create");
      assert.equal(receipt.status, "completed");
      assert.deepEqual(receipt.entityResult, { sessionId: `session:${f.calls.length}`, title: "New Chat" });
      assert.equal(f.calls.at(-1).providerId, providerId);
      // Replaying an accepted intent must not depend on current Provider availability.
      const originalOptions = f.chatCreation.options;
      f.chatCreation.options = () => ({ providers: [] });
      assert.deepEqual(await f.api.createChat(identity, body), receipt);
      f.chatCreation.options = originalOptions;
      await assert.rejects(() => f.api.createChat(identity, { ...body, title: "Different" }), { code: "IDEMPOTENCY_CONFLICT" });
    }
    assert.equal(f.calls.length, 2);
    assert.equal(JSON.stringify(f.api.receipt(identity, "chat-create-a")).includes("PRIVATE"), false);
  } finally { await f.close(); }
});

test("Chat creation validates input, rejects revoked credentials and unsupported resources without dispatch", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ title: " " }, { title: "x".repeat(513) }, { cwd: "/private" }, { requestId: "short" }]) {
      await assert.rejects(() => f.api.createChat(identity, { ...input, ...patch }), { code: "INVALID_CHAT_CREATION" });
    }
    await assert.rejects(() => f.api.createChat(identity, input, () => { throw Object.assign(new Error(), { code: "INVALID_CREDENTIAL" }); }), { code: "INVALID_CREDENTIAL" });
    const disabled = await f.api.createChat(identity, { ...input, providerId: "provider:disabled" });
    assert.equal(disabled.status, "rejected");
    assert.equal(disabled.errorCode, "PROVIDER_CAPABILITY_UNAVAILABLE");
    const missing = await f.api.createChat(identity, { ...input, requestId: "chat-create-missing", agentId: "agent:missing" });
    assert.equal(missing.errorCode, "AGENT_NOT_FOUND");
    assert.equal(f.calls.length, 0);
    await assert.rejects(() => new ClientSessionAPI({ store: f.store }).chatCreationOptions(), { code: "CAPABILITY_UNSUPPORTED" });
  } finally { await f.close(); }
});

test("partial Chat creation failure remains uncertain and is never replayed", async () => {
  const f = await fixture();
  try {
    f.chatCreation.create = async () => { f.calls.push({}); throw new Error("lost result"); };
    const receipt = await f.api.createChat(identity, input);
    assert.equal(receipt.status, "unknown");
    assert.equal(receipt.errorCode, "CHAT_CREATION_UNCERTAIN");
    assert.deepEqual(await f.api.createChat(identity, input), receipt);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
