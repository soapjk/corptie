import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eligibleQuickMessage, rankQuickMessages } from "../src/application/quickMessageRecommendations.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TimelineReadPool } from "../src/store/timelineReadPool.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

test("short exact repeats rank before common defaults; sensitive/attachment content stays out", () => {
  const row = (text, task_id = "a", extra = {}) => ({ text, task_id, ...extra });
  const result = rankQuickMessages([
    row("检查布局"), row(" 检查布局 "), row("检查布局"),
    row("一次性的消息"), row("secret=private"), row("secret=private"),
    row("图片检查", "a", { raw_metadata_json: '{"images":[{}]}' }),
    row("图片检查", "a", { raw_metadata_json: '{"images":[{}]}' })
  ], [row("继续"), row("继续"), row("继续", "b")], "a");
  assert.equal(result.taskId, "a");
  assert.equal(result.items[0].text, "检查布局");
  assert.equal(result.items[0].count, 3);
  assert.equal(result.items[1].scope, "common");
  assert.equal(new Set(result.items.map(item => item.text)).size, result.items.length);
  assert.ok(result.items.length <= 6);
  assert.ok(!result.items.some(item => /secret|图片|一次性/.test(item.text)));
  for (const text of ["/private/path", "https://example.com", "API_KEY=abc", "密码是 abcdef", "联系 user@example.com", "\n继续", "a".repeat(41)]) {
    assert.equal(eligibleQuickMessage(text), null);
  }
});

test("real SQLite read worker isolates Tasks, merges their Sessions across Providers and matches mobile contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-quick-messages-"));
  const dbPath = join(directory, "db.sqlite"), configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath, dataRoot: directory });
  let pool;
  try {
    await store.initialize();
    const agent = store.createAgent({ id: "agent:quick", name: "Quick messages" });
    store.createWork({ id: "w", name: "Work", contributorAgentIds: [agent.agentId] });
    for (const id of ["a", "b"]) store.createTask({ id, workId: "w", title: id });
    for (const [id, provider, taskId] of [["a1", "codex-app-server", "a"], ["a2", "claude-code", "a"], ["b1", "openclacky", "b"]]) {
      store.upsertSession({ id, title: id, agent: "Agent", provider, status: "complete", taskId, workId: "w" });
    }
    let sequence = 0;
    function message(sessionId, text, extra = {}) {
      store.upsertTimelineItemProjection(sessionId, { id: `m${++sequence}`, type: "userMessage", text, ...extra });
    }
    message("a1", "检查布局"); message("a2", "检查布局");
    message("b1", "检查接口"); message("b1", "检查接口");
    message("a1", "继续"); message("a2", "继续"); message("b1", "继续");
    message("a1", "自动化输入", { presentationRole: "automation" });
    message("a1", "自动化输入", { presentationRole: "automation" });
    message("a1", "协作请求", { presentationRole: "collaboration" });
    message("a1", "协作请求", { presentationRole: "collaboration" });
    message("a1", "失败的指令", { status: "failed" }); message("a1", "失败的指令", { status: "failed" });
    pool = new TimelineReadPool({ dbPath, configPath, dataRoot: directory, size: 1 });
    const desktop = await pool.readQuickMessages({ sessionId: "a1" });
    const api = new ClientSessionAPI({ store, readWindow: async () => ({}), actions: () => ({}),
      quickMessages: sessionId => pool.readQuickMessages({ sessionId }) });
    const mobile = await api.quickMessages({ deviceId: "d" }, "a2");
    assert.deepEqual(mobile, desktop);
    assert.ok(desktop.items.some(item => item.text === "检查布局" && item.scope === "task" && item.count === 2));
    assert.ok(!desktop.items.some(item => /检查接口|自动化|协作|失败/.test(item.text)));
    const other = await pool.readQuickMessages({ sessionId: "b1" });
    assert.ok(other.items.some(item => item.text === "检查接口"));
    assert.ok(!other.items.some(item => item.text === "检查布局"));
    message("a1", "检查布局");
    const refreshed = await pool.readQuickMessages({ sessionId: "a1" });
    assert.equal(refreshed.items.find(item => item.text === "检查布局").count, 3,
      "new sends invalidate the bounded recommendation cache immediately");
    await assert.rejects(api.quickMessages({ deviceId: "d" }, "missing"), { code: "SESSION_NOT_AVAILABLE" });
    assert.ok(pool.inFlightByKey.size <= 1);
  } finally {
    await pool?.close(); await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
