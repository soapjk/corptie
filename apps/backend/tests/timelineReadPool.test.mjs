import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TimelineReadPool } from "../src/store/timelineReadPool.mjs";

test("Timeline read pool returns a bounded, revision-consistent snapshot from read-only Workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-read-pool-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath, dataRoot: directory });
  let pool;
  try {
    await store.initialize();
    store.upsertSession({
      id: "timeline-pool-session",
      title: "Timeline Pool",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    for (let index = 0; index < 260; index += 1) {
      store.upsertTimelineItemProjection("timeline-pool-session", {
        id: `item-${String(index).padStart(3, "0")}`,
        type: "agentMessage",
        text: `message ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }
    const authoritativeRevision = store.sessionTimelineRevision("timeline-pool-session");
    pool = new TimelineReadPool({
      dbPath,
      configPath,
      dataRoot: directory,
      size: 2
    });

    const snapshot = await pool.readStoredTimelineSnapshot({
      sessionId: "timeline-pool-session",
      provider: "codex-app-server",
      limit: 200
    });
    assert.equal(snapshot.timelineRevision, authoritativeRevision);
    assert.equal(snapshot.window.items.length, 200);
    assert.equal(snapshot.window.items[0].id, "item-060");
    assert.equal(snapshot.window.items.at(-1).id, "item-259");
    assert.equal(snapshot.window.hasEarlier, true);
    assert.equal(store.sessionTimelineRevision("timeline-pool-session"), authoritativeRevision);
  } finally {
    await pool?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Timeline read pool keeps the calling event loop responsive while Workers read wide windows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-read-responsive-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath, dataRoot: directory });
  let pool;
  try {
    await store.initialize();
    for (let sessionIndex = 0; sessionIndex < 8; sessionIndex += 1) {
      const sessionId = `responsive-${sessionIndex}`;
      store.upsertSession({
        id: sessionId,
        title: sessionId,
        agent: "Codex",
        provider: "codex-app-server",
        status: "complete"
      });
      for (let itemIndex = 0; itemIndex < 200; itemIndex += 1) {
        store.upsertTimelineItemProjection(sessionId, {
          id: `${sessionId}-item-${String(itemIndex).padStart(3, "0")}`,
          type: "agentMessage",
          text: "x".repeat(16_384),
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, itemIndex)).toISOString()
        });
      }
    }
    pool = new TimelineReadPool({ dbPath, configPath, dataRoot: directory, size: 4 });

    let timerFired = false;
    const timer = new Promise((resolve) => setTimeout(() => {
      timerFired = true;
      resolve();
    }, 5));
    const reads = Promise.all(Array.from({ length: 8 }, (_, sessionIndex) => (
      pool.readStoredTimelineSnapshot({
        sessionId: `responsive-${sessionIndex}`,
        provider: "codex-app-server",
        limit: 200
      })
    )));
    await timer;
    assert.equal(timerFired, true, "Worker reads must not monopolize the HTTP event loop");
    const snapshots = await reads;
    assert.equal(snapshots.length, 8);
    assert.ok(snapshots.every((snapshot) => snapshot.window.items.length === 200));
  } finally {
    await pool?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Timeline read pool single-flights duplicate snapshots and rejects work after close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-timeline-read-singleflight-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath, dataRoot: directory });
  let pool;
  try {
    await store.initialize();
    store.upsertSession({
      id: "singleflight",
      title: "Single Flight",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    store.upsertTimelineItemProjection("singleflight", {
      id: "message",
      type: "agentMessage",
      text: "ready"
    });
    pool = new TimelineReadPool({ dbPath, configPath, dataRoot: directory, size: 1 });
    const input = { sessionId: "singleflight", provider: "codex-app-server", limit: 200 };
    const first = pool.readStoredTimelineSnapshot(input);
    const duplicate = pool.readStoredTimelineSnapshot(input);
    assert.equal(first, duplicate);
    assert.deepEqual((await first).window.items.map((item) => item.id), ["message"]);

    await pool.close();
    await assert.rejects(
      pool.readStoredTimelineSnapshot(input),
      (error) => error.code === "TIMELINE_READ_POOL_CLOSED" && error.statusCode === 503
    );
  } finally {
    await pool?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

