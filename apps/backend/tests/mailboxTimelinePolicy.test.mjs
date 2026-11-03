import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ProviderEventProjector } from "../src/application/providerEventProjector.mjs";
import { migrateMailboxTimeline } from "../src/store/migrations/mailboxTimelineMigrations.mjs";

test("mailbox input is fenced across queue writes, Provider echoes and history replay without hiding user messages or replies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-mailbox-timeline-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    store.upsertSession({ id: "session", title: "test", provider: "provider:test", status: "complete" });
    store.createAgent({ id: "role", name: "test", role: "independentContributor" });
    const projector = new ProviderEventProjector({ store });
    for (const source of ["scheduled_session_task", "session_channel", "mailbox_event"]) {
      const task = store.enqueueAgentTask({ taskId: `operation:${source}`, sessionId: "session", agentId: "role",
        kind: "user", priority: 50, text: "same text as user", source: { type: source, mailboxMessageId: `mailbox:${source}` } });
      assert.equal(store.upsertTimelineItemProjection("session", { id: task.taskId, type: "userMessage", text: task.text }), false);
      for (const provider of ["codex", "claude", "openclacky"]) {
        assert.equal(projector.persistItem("session", { id: `${provider}:${source}`, type: "userMessage", text: task.text }, "binding", null, task), false);
      }
      // Simulate an old persisted projection, not an authorized new write.
      store.db.run("INSERT INTO session_items(session_id,id,turn_id,type,text,created_at,turn_status,title) VALUES(?,?,?,?,?,?,'queued','User')",
        ["session", task.taskId, "queued", "userMessage", task.text, "2026-11-01T00:00:00Z"]);
    }
    store.db.run("INSERT INTO session_items(session_id,id,turn_id,type,text,created_at,turn_status,title) VALUES(?,?,?,?,?,?,'completed','Automation')",
      ["session", "old-automation-event", "event", "automationEvent", "triggered", "2026-11-01T00:00:00Z"]);
    store.upsertTimelineItemProjection("session", { id: "real-user", type: "userMessage", text: "same text as user" });
    store.upsertTimelineItemProjection("session", { id: "reply", type: "agentMessage", text: "processed" });
    store.upsertTimelineItemProjection("session", { id: "tool", type: "commandExecution", text: "verification" });
    store.upsertTimelineItemProjection("session", { id: "sent-channel", type: "userMessage", sourceChannel: "session_channel",
      collaborationDirection: "outbound", text: "outbound", rawMetadataJSON: JSON.stringify({ sourceChannel: "session_channel", collaborationDirection: "outbound" }) });
    const revision = store.sessionTimelineRevision("session");
    let migrated = false;
    const options = { db: store.db, selectAll: (...args) => store.selectAll(...args), selectOne: (...args) => store.selectOne(...args),
      runDataMigrationOnce: (_, action) => { if (!migrated) { store.runInTransaction(action); migrated = true; } } };
    migrateMailboxTimeline(options);
    assert.deepEqual(store.getItems("session").map(item => item.id).sort(), ["real-user", "reply", "sent-channel", "tool"]);
    assert.equal(store.sessionTimelineChangesAfter("session", revision).changes.filter(change => change.operation === "delete").length, 4);
    const after = store.sessionTimelineRevision("session");
    migrateMailboxTimeline(options);
    assert.equal(store.sessionTimelineRevision("session"), after);
    assert.equal(store.upsertTimelineItemProjection("session", { id: "operation:scheduled_session_task", type: "userMessage", text: "replayed" }), false);
    assert.ok(store.getAgentTask("operation:scheduled_session_task"));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
