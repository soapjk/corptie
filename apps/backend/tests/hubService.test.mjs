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

function createStartedTask(store) {
  store.createObjective({ id: "o1", name: "Objective" });
  store.createTask({ id: "wi1", objectiveId: "o1", title: "Task" });
  store.createSession({
    id: "s1", title: "Worker", provider: "codex-app-server", status: "running",
    objectiveId: "o1", taskId: "wi1", agentId: "a1"
  });
}

test("retrieveMemory 按作用域聚合 + 关键词匹配", async () => {
  const { store, directory } = await createStore();
  try {
    createStartedTask(store);
    store.createMemory({
      ownerType: "task",
      ownerId: "wi1",
      taskId: "wi1",
      sourceSessionId: "s1",
      kind: "lesson",
      content: "SQLite 外键要手动开",
      confidence: 0.9
    });
    store.createMemory({
      ownerType: "task",
      ownerId: "wi1",
      taskId: "wi1",
      sourceSessionId: "s1",
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
    const results = await hub.retrieveMemory("SQLite 外键", { taskId: "wi1", agentId: "a1" });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "SQLite 外键要手动开");

    const agentResults = await hub.retrieveMemory("发布流程", { taskId: "wi1", agentId: "a1" });
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
    const scope = { agentId: "a1", sessionId: "s1", objectiveId: "o1", taskId: "wi1" };

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

test("缓存 key 含 agentId：同 task 不同 agent 不误命中", async () => {
  const { store, directory } = await createStore();
  try {
    // a1 有 procedure 记忆，a2 没有
    store.createMemory({ ownerType: "agent", ownerId: "a1", kind: "procedure", content: "git commit 流程" });
    const hub = new HubService({ store });
    const shared = { objectiveId: "o1", taskId: "wi1", sessionId: "s1" };

    const first = hub.search("git commit", { ...shared, agentId: "a1" });
    assert.equal(first.cached, false);
    assert.equal(first.found, true);

    // 同一意图 + 同一 task/objective，但 agentId 不同 → 不应命中 a1 的缓存
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

test("hub search indexes only Registry Skills assigned to the Agent and invalidates on replacement", async () => {
  const { store, directory } = await createStore();
  try {
    const agent = store.createAgent({ name: "Investor", provider: "codex-app-server" });
    const other = store.createAgent({ name: "Other", provider: "codex-app-server" });
    const skill = store.createRegistrySkill({
      name: "investrace",
      description: "Investment decisions",
      sourceType: "local",
      source: directory,
      manifestName: "investrace",
      manifestDescription: "Investment decisions"
    });
    store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    const hub = new HubService({ store });

    const assigned = hub.search("investment", { agentId: agent.agentId });
    assert.equal(assigned.found, true);
    assert.equal(assigned.candidates.find((item) => item.skillId === skill.skillId)?.toolName, "investrace");
    assert.equal(hub.search("investment", { agentId: other.agentId }).found, false);

    store.setAgentRegistrySkills(agent.agentId, []);
    const afterRemoval = hub.search("investment", { agentId: agent.agentId });
    assert.equal(afterRemoval.cached, false);
    assert.equal(afterRemoval.found, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("revoked procedure memories are excluded from both memory recall and hub discovery", async () => {
  const { store, directory } = await createStore();
  try {
    store.createMemory({
      ownerType: "agent",
      ownerId: "a1",
      kind: "procedure",
      content: "Deprecated release workflow",
      revokedAt: "2026-08-18T00:00:00.000Z"
    });
    const hub = new HubService({ store });
    assert.deepEqual(await hub.retrieveMemory("release workflow", { agentId: "a1" }), []);
    assert.deepEqual(await hub.retrieveMemory("", { agentId: "a1" }), []);
    assert.equal(hub.discover("release workflow", { agentId: "a1" }).found, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retrieveMemory skips remote embedding when the selected Agent has no active memories", async () => {
  const { store, directory } = await createStore();
  try {
    let embedCalls = 0;
    const hub = new HubService({
      store,
      embedder: async () => {
        embedCalls += 1;
        return [1, 0];
      }
    });

    assert.deepEqual(await hub.retrieveMemory("draft a plan", { agentId: "agent:empty" }), []);
    assert.equal(embedCalls, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retrieveMemory generates missing memory embeddings concurrently and preserves results", async () => {
  const { store, directory } = await createStore();
  try {
    store.createMemory({ ownerType: "agent", ownerId: "agent:1", kind: "fact", content: "first plan memory" });
    store.createMemory({ ownerType: "agent", ownerId: "agent:1", kind: "fact", content: "second plan memory" });
    let activeMemoryEmbeddings = 0;
    let peakMemoryEmbeddings = 0;
    const calls = [];
    const hub = new HubService({
      store,
      embedder: async (text) => {
        calls.push(text);
        if (text === "draft a plan") return [1, 0];
        activeMemoryEmbeddings += 1;
        peakMemoryEmbeddings = Math.max(peakMemoryEmbeddings, activeMemoryEmbeddings);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeMemoryEmbeddings -= 1;
        return [1, 0];
      }
    });

    const results = await hub.retrieveMemory("draft a plan", { agentId: "agent:1" }, { touch: false });

    assert.equal(results.length, 2);
    assert.equal(calls.length, 3);
    assert.equal(peakMemoryEmbeddings, 2);
    for (const memory of results) assert.deepEqual(store.getMemoryEmbedding(memory.id), [1, 0]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
