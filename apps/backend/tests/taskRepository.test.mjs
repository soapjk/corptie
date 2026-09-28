import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Task origin and revision writes retain shared transaction rollback and notification boundaries", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-task-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    const agent = store.createAgent({ name: "Task worker", role: "independentContributor" });
    const work = store.createWork({ name: "Task repository", contributorAgentIds: [agent.agentId] });
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const failure = new Error("injected Task persistence failure");
    const run = store.db.run;
    const failOn = (pattern) => {
      store.db.run = function (sql, ...args) {
        if (sql.includes(pattern)) throw failure;
        return run.call(this, sql, ...args);
      };
    };
    const initialRevision = store.stateRevision();
    failOn("INSERT INTO task_creation_origins");
    try {
      assert.throws(() => store.createTask({ id: "task:retry", workId: work.id, title: "Original" }), error => error === failure);
    } finally {
      store.db.run = run;
    }
    assert.equal(store.getTask("task:retry"), null);
    assert.equal(store.getTaskCreationOrigin("task:retry"), null);
    assert.equal(store.stateRevision(), initialRevision);
    assert.equal(notifications, 0);
    const task = store.createTask({ id: "task:retry", workId: work.id, title: "Original" }, { originType: "direct_user" });
    assert.equal(store.getTaskCreationOrigin(task.id).originType, "direct_user");
    store.upsertSession({ id: "session:revision-rollback", title: "Revision", provider: "test", status: "idle" });
    store.bindSessionToTask("session:revision-rollback", task.id, work.id);
    const before = store.getTask(task.id);
    const revision = store.stateRevision();
    notifications = 0;
    const input = { expectedRevision: 1, createdBySessionId: "session:revision-rollback", next: { title: "Revised" } };
    failOn("UPDATE tasks SET current_snapshot_id");
    try {
      assert.throws(() => store.reviseTask(task.id, input), error => error === failure);
    } finally {
      store.db.run = run;
    }
    assert.deepEqual(store.getTask(task.id), before);
    assert.deepEqual(store.listTaskSnapshots(task.id), []);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    const result = store.reviseTask(task.id, input);
    assert.equal(result.task.revision, 2);
    assert.equal(result.snapshot.title, "Original");
    assert.equal(notifications, 1);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
