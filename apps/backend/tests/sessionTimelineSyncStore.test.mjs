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
    assert.ok(store.stateRevision() > stateRevision, "timeline changes wake the revisioned Session stream");
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
