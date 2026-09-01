import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { filterEvents, deriveMessages, replaySession, forkSession, finalizeRequest, resumeSession } from "../src/application/sessionReplay.mjs";

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
    { sequence: 1, type: "assistant/message", producer: "memory", surface: true, payload: { text: "a" } },
    { sequence: 2, type: "assistant/message", producer: "skill", surface: true, payload: { text: "b" } },
    { sequence: 3, type: "assistant/message", producer: null, surface: true, payload: { text: "c" } }
  ];
  const filtered = filterEvents(events, "memory");
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].sequence, 2);
  assert.equal(filtered[1].sequence, 3);
});

test("deriveMessages 只折叠 surface===true 的事件", () => {
  const events = [
    { sequence: 1, type: "user/message", surface: true, payload: { text: "你好" } },
    { sequence: 2, type: "assistant/chunk", surface: false, payload: { text: "流式增量" } },
    { sequence: 3, type: "assistant/message", surface: true, payload: { text: "完成" } }
  ];
  const messages = deriveMessages(events);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "你好");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].text, "完成");
  assert.equal(messages[1].role, "assistant");
});

test("deriveMessages 映射事件类型到消息角色", () => {
  const events = [
    { sequence: 1, type: "user/message", surface: true, payload: { text: "u" } },
    { sequence: 2, type: "assistant/message", surface: true, payload: { text: "a" } },
    { sequence: 3, type: "memory/inject", surface: true, payload: { text: "m" } },
    { sequence: 4, type: "approval/request", surface: true, payload: { text: "p" } }
  ];
  const roles = deriveMessages(events).map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "system", "approval"]);
});

test("replaySession 反事实重放：剔除 memory 来源", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "assistant/message", producer: "memory", surface: true, payload: { text: "记忆注入" } });
    store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "assistant/message", producer: "skill", surface: true, payload: { text: "技能输出" } });

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

test("forkSession 复制 [0, atSeq] 事件到新 Session", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "原会话", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "user/message", surface: true, payload: { text: "1" } });
    store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "assistant/message", surface: true, payload: { text: "2" } });
    store.appendSessionEvent({ eventId: "e3", sessionId: "s1", type: "assistant/message", surface: true, payload: { text: "3" } });

    const newId = forkSession(store, "s1", 2);
    assert.ok(newId, "应返回新 sessionId");
    assert.notEqual(newId, "s1");

    const forked = store.listSessionEvents(newId);
    // 复制的 2 条 surface 事件 + 1 条 fork 元事件
    const surfaceMessages = forked.filter((e) => e.surface);
    assert.equal(surfaceMessages.length, 2);
    assert.deepEqual(surfaceMessages.map((e) => e.payload.text), ["1", "2"]);

    // 原 session 不受影响（仍是 3 条）
    assert.equal(store.listSessionEvents("s1").length, 3);

    // 新 session 存在且指向同一 task（此处为 null）
    const forkedSession = store.getSession(newId);
    assert.ok(forkedSession, "fork 后的 session 应存在");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("finalizeRequest 发前固化：request/header 落入事件流且非 surface", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "running" });

    const eventId = finalizeRequest(store, "s1", {
      systemPrompt: "你是 Corptie 助手",
      toolSchemas: [{ name: "git_commit", schema: { type: "object" } }],
      callConfig: { model: "gpt-4o", temperature: 0 },
      messages: [{ role: "user", content: "hi" }]
    });

    const events = store.listSessionEvents("s1");
    const header = events.find((e) => e.eventId === eventId);
    assert.ok(header, "request/header 事件应存在");
    assert.equal(header.type, "request/header");
    assert.equal(header.surface, false);
    assert.equal(header.payload.systemPrompt, "你是 Corptie 助手");
    assert.equal(header.payload.toolSchemas.length, 1);

    // 非 surface → 不进入 deriveMessages 投影
    const messages = deriveMessages(events);
    assert.equal(messages.length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumeSession 事件重放：重建消息 + 恢复最近 request/header", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "running" });

    store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "user/message", producer: "user", surface: true, payload: { text: "问题1" } });
    store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "assistant/message", producer: "agent:a", surface: true, payload: { text: "回答1" } });
    store.appendSessionEvent({ eventId: "h1", sessionId: "s1", type: "request/header", producer: "system", surface: false, payload: { systemPrompt: "sys", toolSchemas: [], callConfig: {} } });
    store.appendSessionEvent({ eventId: "e3", sessionId: "s1", type: "user/message", producer: "user", surface: true, payload: { text: "问题2" } });

    // 全量重放
    const full = resumeSession(store, "s1");
    assert.equal(full.messages.length, 3);
    assert.deepEqual(full.messages.map((m) => m.text), ["问题1", "回答1", "问题2"]);
    assert.equal(full.requestHeaders.systemPrompt, "sys");

    // 指定 atSeq 前缀重放（到 seq=2）
    const events = store.listSessionEvents("s1");
    const seq2 = events.find((e) => e.eventId === "e2").sequence;
    const partial = resumeSession(store, "s1", { atSeq: seq2 });
    assert.equal(partial.messages.length, 2);
    assert.deepEqual(partial.messages.map((m) => m.text), ["问题1", "回答1"]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
