import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("binding a Session and Task rolls back both projections before a successful retry", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-association-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    const agent = store.createAgent({ name: "Worker" });
    const work = store.createWork({ name: "Work", contributorAgentIds: [agent.agentId] });
    const task = store.createTask({ title: "Task", workId: work.id });
    const session = store.createSession({ id: "session:binding", title: "Unbound", provider: "test" });
    const revision = store.stateRevision();
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const failure = new Error("injected Task binding failure");
    const run = store.db.run;
    store.db.run = function (sql, ...args) {
      if (sql.includes("UPDATE tasks SET current_session_id = ?")) throw failure;
      return run.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.bindSessionToTask(session.id, task.id, work.id), error => error === failure);
    } finally {
      store.db.run = run;
    }
    assert.deepEqual(store.getSession(session.id), session);
    assert.deepEqual(store.getTask(task.id), task);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    assert.equal(store.bindSessionToTask(session.id, task.id, work.id).taskId, task.id);
    assert.equal(store.getTask(task.id).current_session_id, session.id);
    assert.equal(notifications, 1);
    assert.deepEqual(store.sessionAssociationIssues(), []);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
