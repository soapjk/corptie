import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  ObjectiveApplicationService,
  ObjectiveNotFoundError,
  WorkItemNotFoundError,
  DependencyCycleError,
  SessionNotFoundError
} from "../src/application/objectiveApplicationService.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-objective-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("Objective CRUD：创建 / 列表 / 更新 / 删除", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new ObjectiveApplicationService({ store });

    assert.throws(() => service.createObjective({ name: "  " }), TypeError);

    const objective = service.createObjective({ name: "重构 Corptie" });
    assert.ok(objective.id);
    assert.equal(objective.name, "重构 Corptie");
    assert.equal(objective.status, "active");

    assert.equal(service.listObjectives().length, 1);

    const updated = service.updateObjective(objective.id, { status: "done" });
    assert.equal(updated.status, "done");

    service.deleteObjective(objective.id);
    assert.throws(() => service.getObjective(objective.id), ObjectiveNotFoundError);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("WorkItem 挂 Objective，缺 objective 或 title 报错", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new ObjectiveApplicationService({ store });
    const objective = service.createObjective({ name: "目标" });

    assert.throws(
      () => service.createWorkItem({ objectiveId: objective.id, title: " " }),
      TypeError
    );
    assert.throws(
      () => service.createWorkItem({ title: "无归属" }),
      TypeError
    );
    assert.throws(
      () => service.createWorkItem({ objectiveId: "missing", title: "x" }),
      { code: "OBJECTIVE_NOT_FOUND", field: "objectiveId" }
    );

    const item = service.createWorkItem({ objectiveId: objective.id, title: "建实体表" });
    assert.equal(item.status, "todo");
    assert.equal(item.objective_id, objective.id);

    const items = service.listWorkItemsByObjective(objective.id);
    assert.equal(items.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("依赖环检测：自依赖与传递环被拒", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new ObjectiveApplicationService({ store });
    const objective = service.createObjective({ name: "目标" });
    const a = service.createWorkItem({ objectiveId: objective.id, title: "A" });
    const b = service.createWorkItem({ objectiveId: objective.id, title: "B" });
    const c = service.createWorkItem({ objectiveId: objective.id, title: "C" });

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

test("删除 Objective 级联删除其 WorkItem", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new ObjectiveApplicationService({ store });
    const objective = service.createObjective({ name: "目标" });
    const item = service.createWorkItem({ objectiveId: objective.id, title: "X" });
    assert.ok(service.getWorkItem(item.id));

    service.deleteObjective(objective.id);
    assert.throws(() => service.getWorkItem(item.id), WorkItemNotFoundError);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session 归属接线：upsertSession 写归属 + bindSession 绑定 + 按 WorkItem 列出", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new ObjectiveApplicationService({ store });
    const objective = service.createObjective({ name: "目标" });
    const item = service.createWorkItem({ objectiveId: objective.id, title: "建实体表" });

    // 1) upsertSession 直接带上归属两列
    store.upsertSession({
      id: "s1",
      title: "跑实体表",
      agent: "a",
      provider: "codex-app-server",
      status: "complete",
      objectiveId: objective.id,
      workItemId: item.id
    });
    const s1 = store.getSession("s1");
    assert.equal(s1.objectiveId, objective.id);
    assert.equal(s1.workItemId, item.id);

    // 2) bindSession 把已有 Session 归属到 WorkItem（自动带出 objectiveId）
    store.upsertSession({ id: "s2", title: "孤立 session", agent: "a", provider: "codex-app-server", status: "complete" });
    const bound = service.bindSession("s2", item.id);
    assert.equal(bound.workItemId, item.id);
    assert.equal(bound.objectiveId, objective.id);

    // 3) listSessionsByWorkItem 返回该 WorkItem 名下两个 Session
    const sessions = service.listSessionsByWorkItem(item.id);
    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map((s) => s.id).sort(),
      ["s1", "s2"]
    );

    // 4) 边界：workItem 不存在 / session 不存在
    assert.throws(() => service.bindSession("s2", "missing-wi"), WorkItemNotFoundError);
    assert.throws(() => service.bindSession("missing-session", item.id), SessionNotFoundError);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("按当前活跃 session 反查 WorkItem（session 落定自动推进状态用）", async () => {
  const { store, directory } = await createStore();
  try {
    const service = new ObjectiveApplicationService({ store });
    const objective = service.createObjective({ name: "目标" });
    const item = service.createWorkItem({ objectiveId: objective.id, title: "建实体表" });

    // 未绑定任何 session 时反查为空
    assert.equal(store.getWorkItemBySessionId("s1"), null);

    // bindSession 写入 work_items.current_session_id 后可按 session 反查
    store.upsertSession({ id: "s1", title: "跑实体表", agent: "a", provider: "codex-app-server", status: "running" });
    service.bindSession("s1", item.id);
    const found = store.getWorkItemBySessionId("s1");
    assert.ok(found);
    assert.equal(found.id, item.id);

    // 非当前活跃 session 反查为空
    assert.equal(store.getWorkItemBySessionId("other"), null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
