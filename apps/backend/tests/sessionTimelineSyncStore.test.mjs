import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-sync-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  store.upsertSession({
    id: "session:timeline",
    title: "Timeline",
    agent: "Agent",
    provider: "codex-app-server",
    status: "running"
  });
  return { store, directory };
}

test("timeline item mutations expose ordered replayable revisions", async () => {
  const { store, directory } = await fixture();
  try {
    const stateRevision = store.stateRevision();
    const timelineNotifications = [];
    store.setTimelineDirtyListener((change) => timelineNotifications.push(change));
    store.upsertItemSnapshot("session:timeline", {
      id: "message:1",
      turnId: "turn:1",
      turnStatus: "inProgress",
      type: "agentMessage",
      title: "Agent",
      text: "draft",
      status: "inProgress",
      createdAt: "2026-08-24T01:00:00.000Z"
    });
    store.upsertItemSnapshot("session:timeline", {
      id: "message:1",
      turnId: "turn:1",
      turnStatus: "completed",
      type: "agentMessage",
      title: "Agent",
      text: "final",
      status: "completed",
      createdAt: "2026-08-24T01:00:00.000Z"
    });

    assert.equal(store.sessionTimelineRevision("session:timeline"), 2);
    assert.equal(store.stateRevision(), stateRevision, "timeline data must not dirty control-plane state");
    assert.deepEqual(timelineNotifications.map((change) => change.revision), [1, 2]);
    const first = store.sessionTimelineChangesAfter("session:timeline", 0, 1);
    assert.equal(first.snapshotRequired, false);
    assert.equal(first.revision, 1);
    assert.equal(first.currentRevision, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.changes[0].item.id, "message:1");
    // Hydration is authoritative at read time, so an old upsert never
    // reintroduces stale content while pages are replayed.
    assert.equal(first.changes[0].item.text, "final");

    const second = store.sessionTimelineChangesAfter("session:timeline", first.revision, 10);
    assert.equal(second.baseRevision, 1);
    assert.equal(second.revision, 2);
    assert.equal(second.hasMore, false);
    assert.equal(second.changes[0].item.text, "final");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Provider item identity is scoped to its Session", async () => {
  const { store, directory } = await fixture();
  try {
    store.upsertSession({
      id: "session:other",
      title: "Other",
      agent: "Agent",
      provider: "codex-app-server",
      status: "running"
    });
    const sharedProviderId = "item-1";
    store.upsertItemSnapshot("session:timeline", {
      id: sharedProviderId,
      type: "agentMessage",
      text: "first Session",
      createdAt: "2026-08-24T01:00:00.000Z"
    });
    store.upsertItemSnapshot("session:other", {
      id: sharedProviderId,
      type: "agentMessage",
      text: "second Session",
      createdAt: "2026-08-24T01:00:01.000Z"
    });

    assert.equal(store.getSessionItem("session:timeline", sharedProviderId).text, "first Session");
    assert.equal(store.getSessionItem("session:other", sharedProviderId).text, "second Session");
    assert.equal(store.selectOne(
      "SELECT COUNT(*) AS count FROM session_items WHERE id = ?",
      [sharedProviderId]
    ).count, 2);
    assert.deepEqual(
      store.selectAll("PRAGMA table_info(session_items)")
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      ["session_id", "id"]
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy global item primary key migrates without losing rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-identity-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  let store = new CorptieStore({ dbPath, configPath });
  try {
    await store.initialize();
    store.upsertSession({
      id: "session:legacy",
      title: "Legacy",
      agent: "Agent",
      provider: "codex-app-server",
      status: "complete"
    });
    store.upsertItemSnapshot("session:legacy", {
      id: "item-1",
      type: "agentMessage",
      text: "preserved",
      createdAt: "2026-08-24T01:00:00.000Z"
    });

    for (const suffix of ["insert", "update", "delete"]) {
      store.db.run(`DROP TRIGGER IF EXISTS session_timeline_${suffix}`);
    }
    store.db.run("PRAGMA foreign_keys = OFF");
    store.db.run("BEGIN IMMEDIATE");
    store.db.run("ALTER TABLE session_items RENAME TO session_items_composite_test");
    store.db.run(`
      CREATE TABLE session_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_status TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        options_json TEXT,
        raw_metadata_json TEXT,
        binding_id TEXT,
        presentation_role TEXT,
        presentation_text TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
    store.db.run(`
      INSERT INTO session_items
      SELECT * FROM session_items_composite_test
    `);
    store.db.run("DROP TABLE session_items_composite_test");
    store.db.run("COMMIT");
    store.db.run("PRAGMA foreign_keys = ON");
    await store.close();

    store = new CorptieStore({ dbPath, configPath });
    await store.initialize();
    assert.equal(store.getSessionItem("session:legacy", "item-1").text, "preserved");
    assert.deepEqual(
      store.selectAll("PRAGMA table_info(session_items)")
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      ["session_id", "id"]
    );

    store.upsertSession({
      id: "session:new",
      title: "New",
      agent: "Agent",
      provider: "codex-app-server",
      status: "running"
    });
    store.upsertItemSnapshot("session:new", {
      id: "item-1",
      type: "agentMessage",
      text: "same Provider id, different Session",
      createdAt: "2026-08-24T01:00:01.000Z"
    });
    assert.equal(store.selectOne(
      "SELECT COUNT(*) AS count FROM session_items WHERE id = 'item-1'"
    ).count, 2);
    assert.equal(store.selectOne("PRAGMA quick_check").quick_check, "ok");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeline deletes replay by stable item id and duplicate snapshots are no-ops", async () => {
  const { store, directory } = await fixture();
  try {
    const item = {
      id: "message:delete",
      turnId: "turn:1",
      turnStatus: "completed",
      type: "agentMessage",
      title: "Agent",
      text: "remove me",
      status: "completed",
      createdAt: "2026-08-24T01:00:00.000Z"
    };
    store.upsertItemSnapshot("session:timeline", item);
    const insertedRevision = store.sessionTimelineRevision("session:timeline");
    store.upsertItemSnapshot("session:timeline", item);
    assert.equal(
      store.sessionTimelineRevision("session:timeline"),
      insertedRevision,
      "an identical Provider snapshot must not fan out another revision"
    );

    store.removeItem("session:timeline", item.id);
    const changes = store.sessionTimelineChangesAfter("session:timeline", insertedRevision, 10);
    assert.equal(changes.changes.length, 1);
    assert.deepEqual(changes.changes[0], {
      revision: insertedRevision + 1,
      itemId: item.id,
      operation: "delete",
      item: null,
      changedAt: changes.changes[0].changedAt
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("baseline timelines require a stored snapshot instead of fabricated deltas", async () => {
  const { store, directory } = await fixture();
  try {
    // Simulate a timeline that existed before the change-log protocol.
    store.db.run("DROP TRIGGER session_timeline_insert");
    store.upsertItemSnapshot("session:timeline", {
      id: "legacy",
      type: "agentMessage",
      text: "historical",
      createdAt: "2026-08-24T00:00:00.000Z"
    });
    store.db.run(`
      INSERT INTO session_timeline_revisions (session_id, revision, updated_at)
      VALUES ('session:timeline', 1, '2026-08-24T00:00:00.000Z')
      ON CONFLICT(session_id) DO UPDATE SET revision = 1
    `);

    assert.equal(
      store.sessionTimelineChangesAfter("session:timeline", 0).snapshotRequired,
      true
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
