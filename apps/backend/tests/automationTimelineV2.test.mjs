import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { migrateAutomationTimelineV2 } from "../src/store/migrations/automationTimelineV2.mjs";

test("history migration replaces linked events only, emits deletion deltas, and runs once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corptie-run-cards-"));
  const store = new CorptieStore({dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json")});
  try {
    await store.initialize();
    store.upsertSession({id: "session", title: "test", provider: "provider:test", status: "complete"});
    for (const [i, status] of ["pending", "queued", "completed"].entries()) {
      const eventId = `event:${i}`;
      store.appendSessionEvent({eventId, sessionId: "session", type: ["ScheduledSessionTaskDue", "ScheduledSessionRunQueued", "ScheduledSessionRunCompleted"][i],
        payload: {task: {taskId: "task", name: "Original", message: {text: "instruction"}}, run: {runId: "run", status, createdAt: "2026-10-01T00:00:00Z"}},
        createdAt: "2026-10-01T00:00:00Z"});
      store.upsertTimelineItemProjection("session", {id: `automation-event:${eventId}`, type: "automationEvent", text: "old"});
    }
    store.upsertTimelineItemProjection("session", {id: "ordinary", type: "userMessage", text: "instruction"});
    const revision = store.sessionTimelineRevision("session");
    let migrated = false;
    const options = {db: store.db, selectAll: (...args) => store.selectAll(...args), selectOne: (...args) => store.selectOne(...args),
      runDataMigrationOnce: (_, action) => { if (!migrated) { store.runInTransaction(action); migrated = true; } }};
    migrateAutomationTimelineV2(options);
    assert.equal(store.getSessionItem("session", "automation-run:run").automationRunStatus, "completed");
    assert.equal(store.getSessionItem("session", "ordinary").text, "instruction");
    assert.equal(store.getSessionItem("session", "automation-event:event:0"), null);
    assert.ok(store.sessionTimelineChangesAfter("session", revision).changes.some(c => c.operation === "delete"));
    const after = store.sessionTimelineRevision("session");
    migrateAutomationTimelineV2(options);
    assert.equal(store.sessionTimelineRevision("session"), after);
  } finally { await store.close(); await rm(dir, {recursive: true, force: true}); }
});
