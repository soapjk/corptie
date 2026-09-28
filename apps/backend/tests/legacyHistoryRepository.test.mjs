import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("legacy import is atomic, rollback retains later messages, and conflict never overwrites the Timeline", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-legacy-history-config", manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    store.upsertSession({ id: "session:test", title: "History", agent: "Test",
      provider: "provider:test", status: "complete", createdAt: "2026-01-01T00:00:00.000Z" });
    const item = { id: "item:legacy", turnId: "turn:legacy", turnStatus: "completed",
      type: "agentMessage", title: "Agent", text: "Imported history", createdAt: "2026-01-01T00:00:00.000Z" };
    const input = { sessionId: "session:test", providerId: "provider:test", items: [item] };
    const revision = store.stateRevision();
    let notifications = 0;
    store.setTimelineDirtyListener(() => { notifications += 1; });
    const original = store.db.run;
    const failure = new Error("injected repair receipt failure");
    store.db.run = function (sql, ...args) {
      if (sql.includes("INSERT INTO legacy_history_repairs")) throw failure;
      return original.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.importLegacyHistoryRepair(input), error => error === failure);
    } finally {
      store.db.run = original;
    }
    assert.equal(store.getLegacyHistoryRepair(input.sessionId), null);
    assert.equal(store.getSessionItem(input.sessionId, item.id), null);
    assert.deepEqual(store.selectAll("SELECT * FROM legacy_history_repair_items"), []);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    assert.throws(() => store.importLegacyHistoryRepair({ ...input, items: [item, item] }), /Duplicate/);
    const imported = store.importLegacyHistoryRepair(input);
    assert.equal(imported.status, "imported");
    assert.equal(imported.imported_item_count, 1);
    assert.equal(notifications, 1);
    assert.ok(!store.listLegacyHistoryRepairCandidates({ createdBefore: "2100-01-01" })
      .some(entry => entry.session.id === input.sessionId));
    store.upsertTimelineItemProjection(input.sessionId, { ...item, id: "item:live", text: "Later message" });
    assert.equal(store.rollbackLegacyHistoryRepair(input.sessionId).status, "rolled_back");
    assert.equal(store.getSessionItem(input.sessionId, item.id), null);
    assert.equal(store.getSessionItem(input.sessionId, "item:live").text, "Later message");
    assert.deepEqual(store.selectAll("SELECT * FROM legacy_history_repair_items"), []);
    assert.equal(store.importLegacyHistoryRepair(input).status, "conflict");
    assert.equal(store.getSessionItem(input.sessionId, item.id), null);
    assert.equal(store.getSessionItem(input.sessionId, "item:live").text, "Later message");
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
