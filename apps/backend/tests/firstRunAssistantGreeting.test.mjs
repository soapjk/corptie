import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TimelineReadPool } from "../src/store/timelineReadPool.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { ensureFirstRunAssistantGreeting } from "../src/application/firstRunAssistantGreeting.mjs";

test("introduction persists once and reaches the shared desktop/mobile timeline for every Provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-first-run-greeting-"));
  const options = { dbPath: join(root, "corptie.sqlite"), configPath: join(root, "config.json"), dataRoot: root };
  let store = new CorptieStore(options);
  let pool;
  try {
    await store.initialize();
    pool = new TimelineReadPool({ ...options, size: 1 });
    for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) {
      store.upsertSession({ id: provider, title: "Corptie", provider, status: "idle", sessionKind: "assistantChat" });
      ensureFirstRunAssistantGreeting(store, provider, provider === "claude-sdk" ? "en" : "zh-Hans");
      const first = store.getItems(provider);
      ensureFirstRunAssistantGreeting(store, provider);
      assert.equal(store.getItems(provider).length, 1);
      assert.equal(first[0].type, "agentMessage");
      assert.match(first[0].text, provider === "claude-sdk" ? /Hi, I/ : /你好/);
      const api = new ClientSessionAPI({ store, readWindow: async (sessionId, windowOptions) => {
        const result = await pool.readTimelineWindow({ sessionId, ...windowOptions, provider });
        return { ...result.window, revision: result.timelineRevision };
      }, send: async () => {}, stop: async () => {}, actions: () => ({}) });
      const mobile = await api.messages({ deviceId: "device:test" }, provider, new URLSearchParams());
      assert.equal(mobile.items[0].text, first[0].text);
    }
    await pool.close();
    pool = null;
    await store.close();
    store = new CorptieStore(options);
    await store.initialize();
    for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) {
      ensureFirstRunAssistantGreeting(store, provider);
      assert.equal(store.getItems(provider).length, 1);
    }
  } finally {
    await pool?.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
