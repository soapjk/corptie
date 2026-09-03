import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  WorkApplicationService,
  WorkNotFoundError,
  TaskNotFoundError,
  DependencyCycleError,
  SessionNotFoundError,
  EntityCreationConflictError
} from "../src/application/workApplicationService.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  store.createAgent({ id: "agent:test-worker", name: "Test Worker", role: "independentContributor" });
  return { store, directory };
}

function createWork(service, input) {
  return service.createWork({ ...input, contributorAgentIds: ["agent:test-worker"] });
}

test("Work CRUD：创建 / 列表 / 更新 / 删除", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new WorkApplicationService({ store });

    assert.throws(() => createWork(service, { name: "  " }), TypeError);

    const work = createWork(service, { name: "重构 Corptie" });
    assert.ok(work.id);
    assert.equal(work.name, "重构 Corptie");
    assert.equal(work.status, "active");

    assert.equal(service.listWorks().length, 1);

    const updated = service.updateWork(work.id, { status: "archived" });
    assert.equal(updated.status, "archived");

    service.deleteWork(work.id);
    assert.throws(() => service.getWork(work.id), WorkNotFoundError);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Task 挂 Work，缺 work 或 title 报错", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new WorkApplicationService({ store });
    const work = createWork(service, { name: "目标" });

    assert.throws(
      () => service.createTask({ workId: work.id, title: " " }),
      TypeError
    );
    assert.throws(
      () => service.createTask({ title: "无归属" }),
      TypeError
    );
    assert.throws(
      () => service.createTask({ workId: "missing", title: "x" }),
      { code: "WORK_NOT_FOUND", field: "workId" }
    );

    const item = service.createTask({ workId: work.id, title: "建实体表" });
    assert.equal(item.lifecycle_state, "todo");
    assert.equal(item.work_id, work.id);

    const items = service.listTasksByWork(work.id);
    assert.equal(items.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("稳定创建 ID 使 Work 和 Task 重试幂等，冲突输入明确失败", async () => {
  const { store, directory } = await createStore();
  try {
    const events = [];
    const service = new WorkApplicationService({
      store,
      onEntityChanged: (type, payload) => events.push({ type, payload })
    });
    const workInput = {
      id: "work:background-create",
      name: "后台创建",
      tags: ["popup", "async"]
    };
    const firstWork = createWork(service, workInput);
    const retriedWork = createWork(service, { ...workInput, tags: ["async", "popup"] });
    assert.equal(retriedWork.id, firstWork.id);
    assert.equal(store.listWorks().length, 1);
    assert.equal(events.filter((event) => event.type === "WorkChanged").length, 1);
    assert.throws(
      () => createWork(service, { ...workInput, name: "不同输入" }),
      EntityCreationConflictError
    );

    const taskInput = {
      id: "task:background-create",
      workId: firstWork.id,
      title: "后台工作项",
      description: "保持弹窗可用"
    };
    const firstTask = service.createTask(taskInput);
    const retriedTask = service.createTask(taskInput);
    assert.equal(retriedTask.id, firstTask.id);
    assert.equal(store.listTasks().length, 1);
    assert.equal(events.filter((event) => event.type === "TaskChanged").length, 1);
    assert.throws(
      () => service.createTask({ ...taskInput, title: "不同输入" }),
      EntityCreationConflictError
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("依赖环检测：自依赖与传递环被拒", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new WorkApplicationService({ store });
    const work = createWork(service, { name: "目标" });
    const a = service.createTask({ workId: work.id, title: "A" });
    const b = service.createTask({ workId: work.id, title: "B" });
    const c = service.createTask({ workId: work.id, title: "C" });

    // 自依赖
    assert.throws(() => service.addDependency(a.id, a.id), DependencyCycleError);

    // 正常链 a -> b -> c
    service.addDependency(a.id, b.id);
    service.addDependency(b.id, c.id);
    assert.equal(service.listDependencies(a.id).length, 1);
    assert.equal(service.listDependents(c.id).length, 1);

    // 传递环：c -> a（a 已传递依赖 c）
    assert.throws(() => service.addDependency(c.id, a.id), DependencyCycleError);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("删除 Work 级联删除其 Task", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new WorkApplicationService({ store });
    const work = createWork(service, { name: "目标" });
    const item = service.createTask({ workId: work.id, title: "X" });
    assert.ok(service.getTask(item.id));

    service.deleteWork(work.id);
    assert.throws(() => service.getTask(item.id), TaskNotFoundError);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 归属接线：upsertSession 写归属 + bindSession 绑定 + 按 Task 列出", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new WorkApplicationService({ store });
    const work = createWork(service, { name: "目标" });
    const item = service.createTask({ workId: work.id, title: "建实体表" });

    // 1) upsertSession 直接带上归属两列
    store.upsertSession({
      id: "s1",
      title: "跑实体表",
      agent: "a",
      provider: "codex-app-server",
      status: "complete",
      workId: work.id,
      taskId: item.id
    });
    const s1 = store.getSession("s1");
    assert.equal(s1.workId, work.id);
    assert.equal(s1.taskId, item.id);

    // 2) bindSession 把已有 Session 归属到 Task（自动带出 workId）
    store.upsertSession({ id: "s2", title: "孤立 session", agent: "a", provider: "codex-app-server", status: "complete" });
    const bound = service.bindSession("s2", item.id);
    assert.equal(bound.taskId, item.id);
    assert.equal(bound.workId, work.id);

    // 3) listSessionsByTask 返回该 Task 名下两个 Session
    const sessions = service.listSessionsByTask(item.id);
    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map((s) => s.id).sort(),
      ["s1", "s2"]
    );

    // 4) 边界：task 不存在 / session 不存在
    assert.throws(() => service.bindSession("s2", "missing-wi"), TaskNotFoundError);
    assert.throws(() => service.bindSession("missing-session", item.id), SessionNotFoundError);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("按当前活跃 session 反查 Task（session 落定自动推进状态用）", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new WorkApplicationService({ store });
    const work = createWork(service, { name: "目标" });
    const item = service.createTask({ workId: work.id, title: "建实体表" });

    // 未绑定任何 session 时反查为空
    assert.equal(store.getTaskBySessionId("s1"), null);

    // bindSession 写入 tasks.current_session_id 后可按 session 反查
    store.upsertSession({ id: "s1", title: "跑实体表", agent: "a", provider: "codex-app-server", status: "running" });
    service.bindSession("s1", item.id);
    const found = store.getTaskBySessionId("s1");
    assert.ok(found);
    assert.equal(found.id, item.id);

    // 非当前活跃 session 反查为空
    assert.equal(store.getTaskBySessionId("other"), null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
