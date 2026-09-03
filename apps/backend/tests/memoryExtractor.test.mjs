import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  MemoryExtractor,
  ownerForKind,
  defaultClassify
} from "../src/application/memoryExtractor.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-memory-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

function createStartedExecution(store, {
  workId = "o1",
  taskId = "wi1",
  sessionId = "s1",
  agentId = "a1"
} = {}) {
  if (!store.getWork(workId)) {
    store.createWork({ id: workId, name: workId });
  }
  store.createTask({ id: taskId, workId, title: taskId });
  store.createSession({
    id: sessionId,
    title: sessionId,
    provider: "codex-app-server",
    status: "running",
    workId,
    taskId,
    agentId
  });
}

test("memories CRUD + 置信度衰减", async () => {
  const { store, directory } = await createStore();
  try {
    createStartedExecution(store);
    const memory = store.createMemory({
      ownerType: "task",
      ownerId: "wi1",
      taskId: "wi1",
      sourceSessionId: "s1",
      kind: "lesson",
      content: "SQLite 外键要手动开"
    });
    assert.equal(memory.promotion_status, "active");
    assert.equal(store.listMemoriesByOwner("task", "wi1").length, 1);

    const updated = store.updateMemory(memory.id, { confidence: 0.8 });
    assert.equal(updated.confidence, 0.8);

    store.decayMemories("task", "wi1", 0.5);
    assert.equal(store.getMemory(memory.id).confidence, 0.4);

    store.deleteMemory(memory.id);
    assert.equal(store.getMemory(memory.id), null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MemoryExtractor 提取 + 分类 + kind→owner 分流", async () => {
  const { store, directory } = await createStore();
  try {
    createStartedExecution(store);
    store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "error", payload: { message: "端口被占用" } });
    store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "tool_call", payload: { text: "git commit 流程" } });
    store.appendSessionEvent({ eventId: "e3", sessionId: "s1", type: "summary", payload: { summary: "完成了实体层" } });

    const extractor = new MemoryExtractor({ store });
    const memories = await extractor.extractFromSession("s1", {
      workId: "o1",
      taskId: "wi1",
      agentId: "a1"
    });

    assert.equal(memories.length, 3);
    const lesson = memories.find((m) => m.kind === "lesson");
    const procedure = memories.find((m) => m.kind === "procedure");
    const fact = memories.find((m) => m.kind === "fact");

    // 能力类（procedure）→ Agent 进化记忆
    assert.equal(procedure.owner_type, "agent");
    assert.equal(procedure.owner_id, "a1");
    // 其余 → task 工作记忆
    assert.equal(lesson.owner_type, "task");
    assert.equal(lesson.owner_id, "wi1");
    assert.equal(fact.owner_type, "task");
    assert.equal(lesson.source_type, "extracted");
    assert.equal(lesson.source_session_id, "s1");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two Sessions can append memories to one Agent concurrently without lost writes", async () => {
  const { store, directory } = await createStore();
  try {
    for (const [index, sessionId] of ["s1", "s2"].entries()) {
      createStartedExecution(store, {
        workId: `o${index + 1}`,
        taskId: `wi${index + 1}`,
        sessionId,
        agentId: "agent:shared"
      });
      store.appendSessionEvent({
        eventId: `event:${sessionId}`,
        sessionId,
        type: "tool_call",
        payload: { text: `procedure learned by ${sessionId}` }
      });
    }

    const extractor = new MemoryExtractor({
      store,
      classifyMany: async (events) => {
        await Promise.resolve();
        return events.map((event) => ({
          kind: "procedure",
          content: event.payload.text
        }));
      }
    });
    const [first, second] = await Promise.all([
      extractor.extractFromSession("s1"),
      extractor.extractFromSession("s2")
    ]);

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.deepEqual(
      store.listMemoriesByOwner("agent", "agent:shared")
        .map((memory) => memory.source_session_id)
        .sort(),
      ["s1", "s2"]
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ownerForKind 归属规则", () => {
  assert.deepEqual(ownerForKind("procedure", { agentId: "a" }), { ownerType: "agent", ownerId: "a" });
  assert.deepEqual(ownerForKind("fact", { taskId: "w", workId: "o" }), {
    ownerType: "task",
    ownerId: "w"
  });
  assert.deepEqual(ownerForKind("lesson", { workId: "o" }), {
    ownerType: "work",
    ownerId: "o"
  });
});

test("defaultClassify 类型映射", () => {
  assert.equal(defaultClassify({ type: "error", payload: { message: "x" } }).kind, "lesson");
  assert.equal(defaultClassify({ type: "tool_call", payload: { text: "x" } }).kind, "procedure");
  assert.equal(defaultClassify({ type: "summary", payload: { summary: "x" } }).kind, "fact");
  assert.equal(defaultClassify({ type: "other", payload: {} }), null);
});

test("ownerForKind 缺失 agentId 时能力类返回 null（不再写 owner_id=null）", () => {
  // 能力类记忆必须归属到 Agent；缺失 agentId → null
  assert.equal(ownerForKind("procedure", { workId: "o", taskId: "w" }), null);
  assert.equal(ownerForKind("skill", {}), null);
  // 非能力类缺失 task/work/agent → null
  assert.equal(ownerForKind("lesson", {}), null);
});

test("extractFromSession 缺失 agentId 时跳过能力类事件（不撞 NOT NULL）", async () => {
  const { store, directory } = await createStore();
  try {
    createStartedExecution(store, { agentId: null });
    store.appendSessionEvent({ eventId: "e1", sessionId: "s1", type: "tool_call", payload: { text: "git commit 流程" } });
    store.appendSessionEvent({ eventId: "e2", sessionId: "s1", type: "summary", payload: { summary: "完成" } });

    const extractor = new MemoryExtractor({ store });
    // scope 无 agentId：procedure（能力类）应被跳过，summary（fact）落到 task
    const memories = await extractor.extractFromSession("s1", { workId: "o1", taskId: "wi1" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].kind, "fact");
    assert.equal(memories[0].owner_type, "task");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
