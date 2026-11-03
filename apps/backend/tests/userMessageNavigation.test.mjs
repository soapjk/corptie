import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TimelineReadPool } from "../src/store/timelineReadPool.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { handleSessionTimelineHttpRequest } from "../src/application/sessionTimelineHttpApi.mjs";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-navigation-test-"));
  const store = new CorptieStore({ dbPath: join(directory, "test.sqlite"), configPath: join(directory, "config.json"), dataRoot: directory });
  let pool;
  try {
    await store.initialize();
    store.upsertSession({ id: "one", title: "One", agent: "Agent", provider: "claude-code", status: "idle" });
    store.upsertSession({ id: "two", title: "Two", agent: "Agent", provider: "codex-app-server", status: "idle" });
    pool = new TimelineReadPool({ dbPath: store.dbPath, configPath: store.configPath, dataRoot: directory, size: 1 });
    await run(store, pool);
  } finally { await pool?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
}
function seed(store, count, every = 3, text = "你好🌍 ".repeat(300)) {
  store.db.run("BEGIN");
  try {
    for (let i = 0; i < count; i++) store.db.run(
      "INSERT INTO session_items (turn_id,turn_status,title,session_id,id,type,text,created_at) VALUES ('turn','completed','',?,?,?,?,?)",
      ["one", `m:${String(i).padStart(8, "0")}`, i % every === 0 ? "userMessage" : "agentMessage", text, "2026-11-01T00:00:00Z"]);
    store.db.run("COMMIT");
  } catch (e) { store.db.run("ROLLBACK"); throw e; }
}

test("navigation covers full history by stable keysets with bounded previews and reversible pages", async () => fixture(async (store, pool) => {
  seed(store, 10000);
  const read = input => pool.readUserMessageNavigation({ sessionId: "one", ...input });
  let page = await read({});
  const first = page;
  const seen = new Set();
  let pages = 0;
  while (true) {
    assert.ok(page.items.length <= 128);
    assert.ok(page.scannedCount <= 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 110_000);
    for (const item of page.items) {
      assert.ok([...item.preview].length <= 180);
      assert.ok(!seen.has(item.id)); seen.add(item.id);
      assert.equal(Number(item.id.slice(2)) % 3, 0);
    }
    pages++;
    if (!page.olderCursor) break;
    page = await read({ cursor: page.olderCursor });
    if (pages === 1) {
      const reverse = await read({ cursor: page.newerCursor, direction: "newer" });
      assert.deepEqual(reverse.items, first.items);
    }
  }
  assert.equal(seen.size, 3334);
  assert.ok(pages > 1);
  await assert.rejects(pool.readUserMessageNavigation({ sessionId: "two", cursor: first.olderCursor }), { code: "INVALID_NAVIGATION_CURSOR" });
  await assert.rejects(read({ cursor: "garbage" }), { code: "INVALID_NAVIGATION_CURSOR" });
  await assert.rejects(read({ direction: "newer" }), { code: "INVALID_NAVIGATION_DIRECTION" });
  const plan = store.selectAll("EXPLAIN QUERY PLAN SELECT id FROM session_items WHERE session_id = ? AND (created_at,id) < (?,?) ORDER BY created_at DESC,id DESC LIMIT 1024", ["one", "2026-11-01T00:00:00Z", "m:00005000"]);
  assert.match(JSON.stringify(plan), /INDEX/);
  assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
}));

test("sparse ranges, in-place edits, deletes, backfills and cross-provider sessions stay consistent", async () => fixture(async (store, pool) => {
  seed(store, 2200, 2100);
  const read = () => pool.readUserMessageNavigation({ sessionId: "one" });
  let page = await read();
  assert.equal(page.scannedCount, 1024);
  assert.deepEqual(page.items.map(i => i.id), ["m:00002100"]);
  store.db.run("UPDATE session_items SET text='changed' WHERE session_id='one' AND id='m:00002100'");
  assert.equal((await read()).items[0].preview, "changed");
  store.db.run("DELETE FROM session_items WHERE session_id='one' AND id='m:00002100'");
  page = await read();
  assert.equal(page.items.length, 0);
  assert.ok(page.olderCursor, "empty pages must retain the path through a tool/model-only range");
  const older = await pool.readUserMessageNavigation({ sessionId: "one", cursor: page.olderCursor });
  assert.ok(older.olderCursor);
  store.db.run("INSERT INTO session_items (turn_id,turn_status,title,session_id,id,type,text,created_at) VALUES ('turn','completed','','one','backfill','userMessage','','2020-01-01')");
  const last = await pool.readUserMessageNavigation({ sessionId: "one", cursor: older.olderCursor });
  assert.ok(last.items.some(i => i.id === "backfill" && i.preview === ""));
  assert.deepEqual((await pool.readUserMessageNavigation({ sessionId: "two" })).items, []);
}));

test("both local HTTP and shared client entry resolve Session authority before Worker reads", async () => fixture(async (store, pool) => {
  seed(store, 3);
  const api = new ClientSessionAPI({ store, readWindow: async () => ({}), send: async () => {}, stop: async () => {}, actions: () => ({}),
    userMessageNavigation: input => pool.readUserMessageNavigation(input) });
  assert.equal((await api.userMessageNavigation({}, "one", new URLSearchParams())).items.length, 1);
  await assert.rejects(api.userMessageNavigation({}, "one", new URLSearchParams("cursor=a&cursor=b")), { code: "INVALID_QUERY" });
  const result = await new Promise(resolve => {
    assert.equal(handleSessionTimelineHttpRequest({ request: { method: "GET" }, response: {},
      url: new URL("http://localhost/sessions/public/user-message-navigation"), store,
      sessionApplicationService: { referenceFor: async id => { assert.equal(id, "public"); return { sessionId: "one" }; } },
      getTimelineReadPool: () => pool, sendJson: (_response, status, body) => resolve({ status, body }),
      unifiedErrorStatus: e => e.statusCode ?? 500 }), true);
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.items[0].id, "m:00000000");
  const invalid = await new Promise(resolve => {
    handleSessionTimelineHttpRequest({ request: { method: "GET" }, response: {},
      url: new URL("http://localhost/sessions/one/user-message-navigation?cursor=invalid"), store,
      sessionApplicationService: { referenceFor: async () => ({ sessionId: "one" }) },
      getTimelineReadPool: () => pool, sendJson: (_response, status, body) => resolve({ status, body }),
      unifiedErrorStatus: () => 502 });
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_NAVIGATION_CURSOR");

}));

for (const count of [1000, 10000, 100000]) {
  test(`navigation benchmark ${count} timeline rows`, async () => fixture(async (store, pool) => {
    seed(store, count, 3, "benchmark ".repeat(20));
    const samples = [];
    let maximumBytes = 0;
    for (let i = 0; i < 20; i++) {
      const cursor = Buffer.from(JSON.stringify({ s: "one", t: "2026-11-01T00:00:00Z", i: `m:${String(Math.max(1, Math.floor((count - 1) * (1 - i / 20)))).padStart(8, "0")}` })).toString("base64url");
      const start = performance.now();
      const page = await pool.readUserMessageNavigation({ sessionId: "one", cursor });
      samples.push(performance.now() - start);
      assert.ok(page.scannedCount <= 1024 && page.items.length <= 128);
      maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(page)));
    }
    samples.sort((a,b) => a-b);
    console.log("NAVIGATION_BENCHMARK", JSON.stringify({ rows: count, samples: samples.length,
      medianMs: samples[10], p95Ms: samples[18], maximumBytes, scanLimit: 1024, itemLimit: 128 }));
  }));
}
