import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateSyncService } from "../src/application/stateSyncService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(sessionCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-background-state-sync-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  for (let index = 0; index < sessionCount; index += 1) {
    store.upsertSession({
      id: `session:${index}`,
      title: `Session ${index}`,
      agent: "Agent",
      provider: "codex-app-server",
      status: "complete"
    });
  }
  const snapshot = () => {
    const revisions = store.listSessionTimelineRevisions();
    return {
      sessions: store.listSessions().map((session) => ({
        ...session,
        timelineRevision: revisions.get(session.id) ?? 0
      }))
    };
  };
  return {
    directory,
    store,
    sync: new StateSyncService({ store, snapshot })
  };
}

async function cleanup(fixtureValue) {
  await fixtureValue.store.close();
  await rm(fixtureValue.directory, { recursive: true, force: true });
}

test("every background Session status transition is revisioned without a detail read", async () => {
  const f = await fixture();
  try {
    let clientRevision = f.sync.snapshot().revision;
    for (const status of ["running", "complete", "failed", "cancelled", "blocked"]) {
      const current = f.store.getSession("session:0");
      f.store.upsertSession({ ...current, status, updatedAt: new Date().toISOString() });

      const changes = f.sync.changesAfter(clientRevision);
      assert.equal(changes.snapshotRequired, false);
      assert.equal(changes.baseRevision, clientRevision);
      assert.equal(changes.upserts.sessions.length, 1);
      assert.equal(changes.upserts.sessions[0].id, "session:0");
      assert.equal(changes.upserts.sessions[0].status, status);
      clientRevision = changes.revision;
    }
  } finally {
    await cleanup(f);
  }
});

test("multiple unopened Sessions publish independent timeline cursors without dirtying control-plane state", async () => {
  const f = await fixture(24);
  try {
    const clientRevision = f.sync.snapshot().revision;
    const timelineChanges = [];
    f.store.setTimelineDirtyListener((change) => timelineChanges.push(change));
    for (let index = 0; index < 24; index += 1) {
      f.store.upsertItemSnapshot(`session:${index}`, {
        id: `message:${index}`,
        turnId: `turn:${index}`,
        turnStatus: "completed",
        type: "agentMessage",
        title: "Agent",
        text: `answer ${index}`,
        createdAt: `2026-08-24T00:00:${String(index).padStart(2, "0")}.000Z`
      });
    }

    assert.equal(f.store.stateRevision(), clientRevision);
    assert.equal(f.sync.changesAfter(clientRevision).upserts.sessions.length, 0);
    assert.equal(timelineChanges.length, 24);
    assert.deepEqual(timelineChanges.map((change) => change.revision), Array(24).fill(1));
    for (let index = 0; index < 24; index += 1) {
      const delta = f.store.sessionTimelineChangesAfter(`session:${index}`, 0);
      assert.equal(delta.snapshotRequired, false);
      assert.equal(delta.changes[0].item.text, `answer ${index}`);
    }
  } finally {
    await cleanup(f);
  }
});
