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
    store.appendSessionEvent({ eventId: "dup", sessionId: "s1", type: "message", payload: {} });
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
