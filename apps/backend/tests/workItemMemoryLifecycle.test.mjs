import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryExtractor } from "../src/application/memoryExtractor.mjs";
import { HubService } from "../src/application/hubService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-item-memory-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  store.createObjective({ id: "objective:memory", name: "Memory lifecycle" });
  for (const workItemId of ["work_item:one", "work_item:two"]) {
    store.createWorkItem({
      id: workItemId,
      objectiveId: "objective:memory",
      title: workItemId
    });
  }
  return { directory, dbPath, configPath, store };
}

function start(store, workItemId, sessionId) {
  return store.createSession({
    id: sessionId,
    title: sessionId,
    provider: "codex-app-server",
    status: "running",
    objectiveId: "objective:memory",
    workItemId,
    agentId: "agent:memory"
  });
}

test("WorkItem memory lifecycle starts empty, upserts from execution context, reloads, and stays isolated", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.store.listMemoriesByOwner("work_item", "work_item:one"), []);
    assert.throws(
      () => f.store.createMemory({
        ownerType: "work_item",
        ownerId: "work_item:one",
        workItemId: "work_item:one",
        sourceSessionId: "session:not-started",
        kind: "fact",
        content: "placeholder"
      }),
      { code: "WORK_ITEM_NOT_STARTED" }
    );

    start(f.store, "work_item:one", "session:one");
    start(f.store, "work_item:two", "session:two");
    f.store.appendSessionEvent({
      eventId: "event:one",
      sessionId: "session:one",
      type: "summary",
      payload: { summary: "Initial implementation context" }
    });

    let extractedContent = "Initial implementation context";
    const extractor = new MemoryExtractor({
      store: f.store,
      classify: () => ({ kind: "fact", content: extractedContent, baseConfidence: 0.8 })
    });
    const created = await extractor.extractFromSession("session:one");
    assert.equal(created.length, 1);
    assert.equal(created[0].work_item_id, "work_item:one");
    assert.equal(created[0].source_session_id, "session:one");
    assert.equal(created[0].source_event_sequence, 1);

    extractedContent = "Implementation and verification context updated";
    const updated = await extractor.extractFromSession("session:one");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].id, created[0].id);
    assert.equal(updated[0].content, extractedContent);
    assert.equal(updated[0].version, 2);
    assert.equal(f.store.listMemoriesByOwner("work_item", "work_item:one").length, 1);
    assert.deepEqual(f.store.listMemoriesByOwner("work_item", "work_item:two"), []);
    assert.deepEqual(
      (await new HubService({ store: f.store }).retrieveMemory("verification", {
        workItemId: "work_item:two"
      }, { touch: false })).map((memory) => memory.id),
      []
    );
    assert.throws(
      () => f.store.createMemory({
        ownerType: "work_item",
        ownerId: "work_item:two",
        workItemId: "work_item:two",
        sourceSessionId: "session:one",
        kind: "fact",
        content: "cross-work-item leak"
      }),
      { code: "INVALID_MEMORY_SOURCE_SESSION" }
    );

    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();
    const reloaded = f.store.listMemoriesByOwner("work_item", "work_item:one");
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].content, extractedContent);
    assert.equal(reloaded[0].work_item_id, "work_item:one");
    assert.deepEqual(f.store.listMemoriesByOwner("work_item", "work_item:two"), []);
    assert.deepEqual(
      f.store.stateConsistencyIssues().filter((issue) => issue.code.startsWith("memory_")),
      []
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("association migration quarantines legacy placeholder and orphan WorkItem memories", async () => {
  const f = await fixture();
  try {
    f.store.db.run("DROP TRIGGER memories_work_item_insert_guard");
    f.store.db.run("DROP TRIGGER memories_work_item_update_guard");
    f.store.db.run("DELETE FROM data_migrations WHERE migration_id = 'work-item-memory-association-v1'");
    const timestamp = "2026-08-22T00:00:00.000Z";
    f.store.db.run(
      `INSERT INTO memories (
         id, owner_type, owner_id, kind, content, created_at, updated_at
       ) VALUES (?, 'work_item', ?, 'fact', ?, ?, ?)`,
      ["memory:placeholder", "work_item:one", "Predefined placeholder memory", timestamp, timestamp]
    );
    f.store.db.run(
      `INSERT INTO memories (
         id, owner_type, owner_id, kind, content, created_at, updated_at
       ) VALUES (?, 'work_item', ?, 'fact', ?, ?, ?)`,
      ["memory:orphan", "work_item:missing", "Cross-item orphan", timestamp, timestamp]
    );

    f.store.migrateWorkItemMemoryAssociations();

    assert.equal(f.store.getMemory("memory:placeholder"), null);
    assert.equal(f.store.getMemory("memory:orphan"), null);
    assert.deepEqual(
      f.store.selectAll("SELECT memory_id, reason FROM quarantined_work_item_memories ORDER BY memory_id"),
      [
        { memory_id: "memory:orphan", reason: "work_item_missing" },
        { memory_id: "memory:placeholder", reason: "work_item_not_started" }
      ]
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
