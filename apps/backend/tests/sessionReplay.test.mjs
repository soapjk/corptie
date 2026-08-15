import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { filterEvents, deriveMessages, replaySession } from "../src/application/sessionReplay.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-replay-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("filterEvents 按 producer 过滤", () => {
  const events = [
    { sequence: 1, type: "message", source: { producer: "memory" }, payload: { text: "a" } },
    { sequence: 2, type: "message", source: { producer: "skill" }, payload: { text: "b" } },
    { sequence: 3, type: "message", source: null, payload: { text: "c" } }
  ];
  const filtered = filterEvents(events, "memory");
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].sequence, 2);
  assert.equal(filtered[1].sequence, 3);
});

test("deriveMessages 投影消息", () => {
  const events = [
    { sequence: 1, type: "message", payload: { text: "你好" } },
    { sequence: 2, type: "tool_call", payload: { text: "git commit" } },
    { sequence: 3, type: "message", payload: { text: "完成" } }
  ];
  const messages = deriveMessages(events);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].text, "你好");
});

test("replaySession 反事实重放：剔除 memory 来源", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "message", source: { producer: "memory" }, payload: { text: "记忆注入" } });
    store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "message", source: { producer: "skill" }, payload: { text: "技能输出" } });

    const replay = replaySession(store, "s1", { excludedProducers: ["memory"] });
    assert.equal(replay.totalEvents, 2);
    assert.equal(replay.keptEvents, 1);
    assert.equal(replay.messages.length, 1);
    assert.equal(replay.messages[0].text, "技能输出");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
