import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { buildQuickMessageBatch, initializeQuickMessageIndex } from "../src/store/quickMessageIndex.mjs";
import { readQuickMessages } from "../src/application/quickMessageRecommendations.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-quick-index-"));
  const options = { dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json"), dataRoot: directory };
  const store = new CorptieStore(options);
  await store.initialize();
  await store.quickMessageBuild;
  const agent = store.createAgent({ name: "Test" });
  store.createWork({ id: "work", name: "Work", contributorAgentIds: [agent.agentId] });
  for (const id of ["a", "b"]) store.createTask({ id, workId: "work", title: id });
  for (const [id, taskId] of [["one", "a"], ["two", "b"], ["other", "a"]]) {
    store.createSession({ id, taskId, workId: "work", title: id, sessionKind: "worker" });
  }
  const write = (id, text = "检查布局", extra = {}, session = "one") => store.upsertTimelineItemProjection(session,
    { id, text, type: "userMessage", createdAt: "2026-01-01T00:00:00Z", ...extra });
  const revisions = () => store.selectAll("SELECT * FROM quick_message_revisions_v1 ORDER BY session_id");
  return { directory, options, store, write, revisions, close: async () => {
    await store.close(); await rm(directory, { recursive: true, force: true });
  } };
}

test("incremental statistics follow eligibility, replay, rollback, edits, clears and direct SQL deletes", async () => {
  const f = await fixture();
  try {
    const { store, write } = f;
    write("1"); write("2"); write("2");
    assert.equal(readQuickMessages(store, "one").items[0].count, 2);
    const before = f.revisions();
    write("2", "检查布局", { status: "completed" });
    for (let i = 0; i < 10; i++) write("stream", `token ${i}`, { type: "agentMessage", status: "streaming" });
    write("private", "password hidden");
    write("images", "检查布局", { rawMetadataJSON: '{"images":[{}]}' });
    assert.deepEqual(f.revisions(), before, "streaming and ineligible messages do not invalidate recommendations");
    assert.throws(() => store.runInTransaction(() => { write("rollback"); throw new Error("rollback"); }));
    assert.deepEqual(f.revisions(), before);
    write("2", "检查布局", { status: "failed" });
    assert.ok(!readQuickMessages(store, "one").items.some(item => item.text === "检查布局"));
    write("2"); write("1", "检查接口");
    assert.ok(!readQuickMessages(store, "one").items.some(item => item.text === "检查布局"));
    write("1");
    store.db.run("DELETE FROM session_items WHERE session_id='one' AND id='2'");
    assert.equal(store.selectOne("SELECT SUM(count) AS n FROM quick_message_stats_v1").n, 1);
    store.clearItems("one");
    assert.equal(store.selectOne("SELECT COUNT(*) AS n FROM quick_message_stats_v1").n, 0);
  } finally { await f.close(); }
});

test("scope membership, common last-use removal and Session deletion invalidate only relevant results", async () => {
  const f = await fixture();
  try {
    const { store, write } = f;
    write("1", "总结一下"); write("2", "总结一下"); write("3", "总结一下", {}, "two");
    assert.equal(readQuickMessages(store, "other").items.find(i => i.text === "总结一下").count, 2);
    assert.equal(readQuickMessages(store, "two").items.find(i => i.text === "总结一下").scope, "common");
    const cached = readQuickMessages(store, "one");
    write("unrelated", "别的任务内容", {}, "two");
    assert.equal(readQuickMessages(store, "one"), cached, "unrelated non-common writes retain the cached result");
    write("3", "总结一下", { status: "cancelled" }, "two");
    assert.ok(!readQuickMessages(store, "two").items.some(i => i.text === "总结一下"));
    store.bindSessionToTask("one", "b", "work");
    assert.ok(!readQuickMessages(store, "other").items.some(i => i.text === "总结一下"));
    assert.equal(readQuickMessages(store, "two").items.find(i => i.text === "总结一下").count, 2);
    store.deleteSession("one");
    assert.ok(!readQuickMessages(store, "two").items.some(i => i.text === "总结一下"));
  } finally { await f.close(); }
});

test("history build is bounded, resumable and idempotent with concurrent live edits and sends", async () => {
  const f = await fixture();
  let reopened;
  try {
    const { store, write } = f;
    store.db.run("DROP TRIGGER quick_message_item_insert_v1");
    for (let i = 0; i < 25; i++) write(`old-${i}`, "历史指令");
    store.db.run("UPDATE quick_message_build_v1 SET last_row=0,high_row=(SELECT MAX(rowid) FROM session_items),ready=0");
    initializeQuickMessageIndex(store, { schedule: false });
    assert.equal(readQuickMessages(store, "one").preparationStatus, "building");
    const api = new ClientSessionAPI({ store, quickMessages: id => readQuickMessages(store, id) });
    await assert.rejects(api.quickMessages({ deviceId: "test" }, "one"),
      { code: "QUICK_MESSAGE_STATISTICS_PREPARING", status: 503 });
    assert.equal(buildQuickMessageBatch(store, 5), false);
    write("old-10", "历史指令", { status: "cancelled" });
    write("old-11", "新指令");
    write("live", "历史指令");
    assert.equal(buildQuickMessageBatch(store, 5), false);
    const checkpoint = store.selectOne("SELECT last_row FROM quick_message_build_v1").last_row;
    await store.close();
    reopened = new CorptieStore(f.options);
    await reopened.initialize({ performMigrations: false });
    assert.ok(reopened.selectOne("SELECT last_row FROM quick_message_build_v1").last_row >= checkpoint);
    await reopened.quickMessageBuild;
    const result = readQuickMessages(reopened, "one");
    assert.equal(result.items.find(i => i.text === "历史指令").count, 24);
    assert.equal(reopened.selectOne("SELECT SUM(count) AS n FROM quick_message_stats_v1").n, 25);
    assert.equal(buildQuickMessageBatch(reopened), true);
  } finally { await reopened?.close(); await f.close(); }
});

test("recommendation reads use indexed statistics, independent of large tool history", async () => {
  const f = await fixture();
  try {
    const { store, write } = f;
    write("1"); write("2");
    store.db.run(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<100000)
      INSERT INTO session_items(id,session_id,turn_id,turn_status,title,type,text,created_at)
      SELECT 'tool-'||v,'one','tools','completed','','commandExecution',printf('%.*c',512,120),'2026-01-01' FROM n`);
    const queries = [];
    const all = store.selectAll.bind(store), one = store.selectOne.bind(store);
    store.selectAll = (sql, args) => { queries.push(sql); return all(sql, args); };
    store.selectOne = (sql, args) => { queries.push(sql); return one(sql, args); };
    const elapsed = [];
    for (let i = 0; i < 30; i++) {
      write(`fresh-${i}`);
      queries.length = 0;
      const start = performance.now();
      assert.equal(readQuickMessages(store, "one").items[0].count, i + 3);
      elapsed.push(performance.now() - start);
      assert.ok(queries.every(sql => !/session_items/.test(sql)));
    }
    const p95 = elapsed.sort((a, b) => a - b)[28];
    assert.ok(p95 < 200, `P95 ${p95.toFixed(1)}ms`);
    const plan = store.selectAll("EXPLAIN QUERY PLAN SELECT * FROM quick_message_stats_v1 WHERE trim(text) IN ('继续','开始开发')");
    assert.ok(plan.some(row => row.detail.includes("idx_quick_message_stats_common")));
    console.log(`Quick-message statistics: 100k tool rows, 30 invalidated reads, P95 ${p95.toFixed(2)}ms`);
  } finally { await f.close(); }
});
