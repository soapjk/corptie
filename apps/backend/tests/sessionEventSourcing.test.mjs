import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-eventsourcing-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("appendSessionEvent：sequence 单调递增且真实落库", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const e1 = store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "user/message", payload: { text: "a" } });
    const e2 = store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "assistant/message", payload: { text: "b" } });
    assert.equal(e1.sequence, 1);
    assert.equal(e2.sequence, 2);
    const listed = store.listSessionEvents("s1");
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((e) => e.sequence), [1, 2]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendSessionEvent：event_id 冲突时显式抛错，不返回虚假 sequence", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    assert.equal(store.hasSessionEvent("dup"), false);
    store.appendSessionEvent({ eventId: "dup", sessionId: "s1", type: "message", payload: {} });
    assert.equal(store.hasSessionEvent("dup"), true);
    assert.throws(
      () => store.appendSessionEvent({ eventId: "dup", sessionId: "s1", type: "message", payload: {} }),
      /Duplicate event_id/
    );
    // 冲突未落库，sequence 仍为 1
    assert.equal(store.listSessionEvents("s1").length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendSessionEvent：surface / producer / call_id / source_event_seqs 落库", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const event = store.appendSessionEvent({
      eventId: "e1",
      sessionId: "s1",
      type: "tool/call",
      producer: "skill:foo",
      surface: false,
      callId: "call-1",
      sourceEventSeqs: [3],
      payload: { name: "run" }
    });
    assert.equal(event.producer, "skill:foo");
    assert.equal(event.surface, false);
    assert.equal(event.callId, "call-1");
    assert.deepEqual(event.sourceEventSeqs, [3]);

    const listed = store.listSessionEvents("s1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].producer, "skill:foo");
    assert.equal(listed[0].surface, false);
    assert.equal(listed[0].callId, "call-1");
    assert.deepEqual(listed[0].sourceEventSeqs, [3]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendSessionEvent：surface 按类型推导（user/message → true）", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const event = store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "user/message", payload: { text: "hi" } });
    assert.equal(event.surface, true);
    assert.equal(store.listSessionEvents("s1")[0].surface, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("listLatestSessionMessageTimes：只按消息事件返回每个 Session 的最新时间", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({
      eventId: "message-1", sessionId: "s1", type: "user/message", surface: true,
      payload: { text: "hello" }, createdAt: "2026-08-20T01:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "tool", sessionId: "s1", type: "tool/call", surface: false,
      payload: { name: "exec" }, createdAt: "2026-08-20T03:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "message-2", sessionId: "s1", type: "CodexThreadCompleted", surface: false,
      payload: {}, createdAt: "2026-08-20T02:00:00Z"
    });

    assert.equal(store.listLatestSessionMessageTimes().get("s1"), "2026-08-20T02:00:00Z");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 列表消息聚合使用稀疏索引且不创建临时排序 B-tree", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    store.appendSessionEvent({
      eventId: "status-noise", sessionId: "s1", type: "ProviderSessionChanged",
      payload: { status: "running" }, createdAt: "2026-08-20T00:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "message", sessionId: "s1", type: "SessionUserMessageCreated",
      payload: { text: "hello" }, createdAt: "2026-08-20T01:00:00Z"
    });
    store.appendSessionEvent({
      eventId: "completion", sessionId: "s1", type: "AgentTurnCompleted",
      payload: { hasAgentMessage: true }, createdAt: "2026-08-20T02:00:00Z"
    });

    const originalSelectAll = store.selectAll.bind(store);
    const capturedSQL = [];
    store.selectAll = (sql, params = []) => {
      capturedSQL.push(sql);
      return originalSelectAll(sql, params);
    };
    store.listLatestSessionMessageTimes();
    store.listSessionMessageCursors();
    store.selectAll = originalSelectAll;

    const plans = capturedSQL.map((sql) => originalSelectAll(`EXPLAIN QUERY PLAN ${sql}`)
      .map((row) => row.detail)
      .join("\n"));
    assert.match(plans[0], /idx_session_events_latest_message/);
    assert.match(plans[1], /idx_session_events_agent_message/);
    assert.doesNotMatch(plans.join("\n"), /USE TEMP B-TREE/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 未读游标：只计算 Agent 正文并持久化单调已读回执", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "running" });
    store.appendSessionEvent({ eventId: "user", sessionId: "s1", type: "user/message", payload: { text: "hi" } });
    store.appendSessionEvent({ eventId: "tool", sessionId: "s1", type: "tool/call", payload: { name: "exec" } });
    store.appendSessionEvent({
      eventId: "reasoning", sessionId: "s1", type: "assistant/message",
      payload: { text: "thinking", itemType: "reasoning" }
    });
    assert.deepEqual(store.listSessionMessageCursors().get("s1"), {
      lastAgentMessageSequence: 0,
      lastReadMessageSequence: 0
    });

    store.appendSessionEvent({
      eventId: "answer", sessionId: "s1", type: "assistant/message",
      payload: { text: "done", itemType: "agentMessage" }
    });
    assert.equal(store.lastAgentMessageSequence("s1"), 0, "a reply is not unread before the turn completes");
    const completion = store.appendSessionEvent({
      eventId: "completion", sessionId: "s1", type: "AgentTurnCompleted",
      payload: { hasAgentMessage: true, session: { status: "complete", summary: "done" } }
    });
    assert.equal(store.lastAgentMessageSequence("s1"), completion.sequence);
    const beforeRevision = store.stateRevision();
    assert.deepEqual(store.markSessionMessagesRead("s1", completion.sequence), {
      lastAgentMessageSequence: completion.sequence,
      lastReadMessageSequence: completion.sequence
    });
    assert.ok(store.stateRevision() > beforeRevision, "receipt change must invalidate the Session projection");

    const readRevision = store.stateRevision();
    store.markSessionMessagesRead("s1", 0);
    assert.equal(store.listSessionMessageCursors().get("s1").lastReadMessageSequence, completion.sequence);
    assert.equal(store.stateRevision(), readRevision, "an older receipt must be a no-op");
    assert.throws(() => store.markSessionMessagesRead("s1", completion.sequence + 1), /Invalid read sequence/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 未读游标：迁移完成后新消息没有隐式已读回执", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const completion = store.appendSessionEvent({
      eventId: "completion", sessionId: "s1", type: "CodexThreadCompleted",
      payload: { hasAgentMessage: true, session: { status: "complete", summary: "done" } }
    });
    // A newly created Session after migration has no implicit receipt.
    assert.deepEqual(store.listSessionMessageCursors().get("s1"), {
      lastAgentMessageSequence: completion.sequence,
      lastReadMessageSequence: 0
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session_logs：创建 session 即建立 1:1 log，事件指向该 log", async () => {
  const { store, directory } = await createStore();
  try {
    store.upsertSession({ id: "s1", title: "t", agent: "a", provider: "codex-app-server", status: "complete" });
    const log = store.selectOne("SELECT * FROM session_logs WHERE session_id = ?", ["s1"]);
    assert.ok(log, "session_log 应存在");
    assert.equal(log.id, "log:s1");

    const event = store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "message", payload: {} });
    assert.equal(event.logId, "log:s1");
    const row = store.selectOne("SELECT log_id FROM session_events WHERE event_id = ?", ["e1"]);
    assert.equal(row.log_id, "log:s1");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
