import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Work and Task persistence enforce all title writes without migrating historical titles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-title-persistence-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    const agent = store.createAgent({ name: "Worker", role: "independentContributor" });
    const work = store.createWork({ name: "Work-SDK_v2", contributorAgentIds: [agent.agentId] });
    const task = store.createTask({ workId: work.id, title: "Task-SDK_v2" });
    for (const value of ["1Task", "收益%", "名称，测试", "Name.One", " Name", "Name\n"]) {
      assert.throws(() => store.createWork({ name: value, contributorAgentIds: [agent.agentId] }), { code: "INVALID_ENTITY_NAME" });
      assert.throws(() => store.createTask({ workId: work.id, title: value }), { code: "INVALID_ENTITY_NAME" });
      assert.throws(() => store.updateWork(work.id, { name: value }), { code: "INVALID_ENTITY_NAME" });
      assert.throws(() => store.updateTask(task.id, { title: value }), { code: "INVALID_ENTITY_NAME" });
    }
    assert.equal(store.getWork(work.id).name, "Work-SDK_v2");
    assert.equal(store.getTask(task.id).title, "Task-SDK_v2");
    // Simulate data written by an old version, only in this isolated test DB.
    store.db.run("UPDATE works SET name=? WHERE id=?", ["Legacy Work，名称", work.id]);
    store.db.run("UPDATE tasks SET title=? WHERE id=?", ["123 Old Task。", task.id]);
    store.updateWork(work.id, { description: "Edited description" });
    store.updateTask(task.id, { description: "Edited description", autoTitleEnabled: false });
    assert.equal(store.getWork(work.id).name, "Legacy Work，名称");
    assert.equal(store.getTask(task.id).title, "123 Old Task。");
    assert.equal(store.updateTask(task.id, { title: "策略_v2" }).title, "策略_v2");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
