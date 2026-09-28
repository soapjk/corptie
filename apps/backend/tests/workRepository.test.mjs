import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Work and contributor replacement roll back together and retain Task assignment scope", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-work-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    for (const id of ["agent:one", "agent:two"]) {
      store.createAgent({ id, name: id, role: "independentContributor" });
    }
    const work = store.createWork({ id: "work:test", name: "Original", contributorAgentIds: ["agent:one"] });
    const revision = store.stateRevision();
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const original = store.db.run;
    const failure = new Error("injected contributor failure");
    store.db.run = function (sql, ...args) {
      if (sql.includes("INSERT INTO work_contributors")) throw failure;
      return original.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.updateWork(work.id, { name: "Changed", contributorAgentIds: ["agent:two"] }), error => error === failure);
    } finally {
      store.db.run = original;
    }
    assert.deepEqual(store.getWork(work.id), work);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    const updated = store.updateWork(work.id, { name: "Changed", contributorAgentIds: ["agent:one", "agent:two"], primaryAgentId: "agent:two" });
    assert.equal(updated.primaryAgentId, "agent:two");
    assert.equal(notifications, 1);
    store.createTask({ id: "task:test", workId: work.id, title: "Assigned", mainAgentId: "agent:one" });
    assert.throws(() => store.updateWork(work.id, { contributorAgentIds: ["agent:two"] }), { code: "WORK_SCOPE_CONFLICT" });
    assert.deepEqual(store.getWork(work.id), updated);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
