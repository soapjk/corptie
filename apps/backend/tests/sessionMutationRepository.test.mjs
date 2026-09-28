import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Session tombstone failure rolls back timeline deletion and retry prevents Provider resurrection", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-session-mutation-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    const session = { id: "session:delete-retry", title: "Persisted", provider: "test", status: "idle" };
    store.upsertSession(session);
    store.upsertTimelineItemProjection(session.id, { id: "item:test", type: "agentMessage", text: "Preserve on rollback", createdAt: "2026-09-27T00:00:00.000Z" });
    const before = store.getSession(session.id);
    const items = store.getItems(session.id);
    const revision = store.stateRevision();
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const run = store.db.run;
    const failure = new Error("injected tombstone failure");
    store.db.run = function (sql, ...args) {
      if (sql.includes("SET deleted_at = ?")) throw failure;
      return run.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.deleteSession(session.id), error => error === failure);
    } finally {
      store.db.run = run;
    }
    assert.deepEqual(store.getSession(session.id), before);
    assert.deepEqual(store.getItems(session.id), items);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    assert.equal(store.deleteSession(session.id), true);
    assert.equal(notifications, 1);
    assert.equal(store.getSession(session.id), null);
    assert.deepEqual(store.getItems(session.id), []);
    const deletedRevision = store.stateRevision();
    assert.equal(store.upsertSession(session), false);
    assert.equal(store.deleteSession(session.id), false);
    assert.equal(store.stateRevision(), deletedRevision);
    assert.equal(notifications, 1);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
