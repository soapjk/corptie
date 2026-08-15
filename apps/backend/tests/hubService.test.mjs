import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { HubService } from "../src/application/hubService.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-hub-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("retrieveMemory 按作用域聚合 + 关键词匹配", async () => {
  const { store, directory } = await createStore();
  try {
    store.createMemory({
      ownerType: "work_item",
      ownerId: "wi1",
      kind: "lesson",
      content: "SQLite 外键要手动开",
      confidence: 0.9
    });
    store.createMemory({
      ownerType: "work_item",
      ownerId: "wi1",
      kind: "fact",
      content: "无关内容",
      confidence: 0.9
    });
    store.createMemory({
      ownerType: "agent",
      ownerId: "a1",
      kind: "procedure",
      content: "发布流程：先构建再推送",
      confidence: 0.8
    });

    const hub = new HubService({ store });
    const results = hub.retrieveMemory("SQLite 外键", { workItemId: "wi1", agentId: "a1" });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "SQLite 外键要手动开");

    const agentResults = hub.retrieveMemory("发布流程", { workItemId: "wi1", agentId: "a1" });
    assert.equal(agentResults[0].owner_type, "agent");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("search 去抖缓存：第二次命中 cached", async () => {
  const { store, directory } = await createStore();
  try {
    store.createMemory({
      ownerType: "agent",
      ownerId: "a1",
      kind: "procedure",
      content: "git commit 流程"
    });
    const hub = new HubService({ store });
    const scope = { agentId: "a1", sessionId: "s1", objectiveId: "o1", workItemId: "wi1" };

    const first = hub.search("git commit", scope);
    assert.equal(first.cached, false);
    assert.equal(first.found, true);

    const second = hub.search("git commit", scope);
    assert.equal(second.cached, true);
    assert.equal(second.found, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("discover none 三岔路 + 活跃工具集", async () => {
  const { store, directory } = await createStore();
  try {
    const hub = new HubService({ store });

    const noneResult = hub.discover("某需求", { agentId: "a1" });
    assert.equal(noneResult.found, false);
    assert.equal(noneResult.decision, "none");

    hub.registerActiveTool("s1", "git_commit", { desc: "git 提交" });
    const tools = hub.listActiveTools("s1");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool_name, "git_commit");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("缓存 key 含 agentId：同 workItem 不同 agent 不误命中", async () => {
  const { store, directory } = await createStore();
  try {
    // a1 有 procedure 记忆，a2 没有
    store.createMemory({ ownerType: "agent", ownerId: "a1", kind: "procedure", content: "git commit 流程" });
    const hub = new HubService({ store });
    const shared = { objectiveId: "o1", workItemId: "wi1", sessionId: "s1" };

    const first = hub.search("git commit", { ...shared, agentId: "a1" });
    assert.equal(first.cached, false);
    assert.equal(first.found, true);

    // 同一意图 + 同一 workItem/objective，但 agentId 不同 → 不应命中 a1 的缓存
    const second = hub.search("git commit", { ...shared, agentId: "a2" });
    assert.equal(second.cached, false);
    assert.equal(second.found, false); // a2 无 procedure 记忆

    // 相同 agentId 再次查询 → 命中缓存
    const third = hub.search("git commit", { ...shared, agentId: "a1" });
    assert.equal(third.cached, true);
    assert.equal(third.found, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
