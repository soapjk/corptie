import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-pages-"));
  const store = new CorptieStore({
    dbPath: join(root, "corptie.sqlite"),
    configPath: join(root, "config.json")
  });
  await store.initialize();
  const objective = store.createObjective({ name: "Bounded collections" });
  return { root, store, objective };
}

test("Task pages are stable, active-first, bounded, and expose continuation", async () => {
  const { root, store, objective } = await fixture();
  try {
    const tasks = Array.from({ length: 8 }, (_, index) => store.createTask({
      objectiveId: objective.id,
      title: `Task ${index}`
    }));
    for (const [index, task] of tasks.slice(0, 3).entries()) {
      const operationId = `completion:${index}`;
      store.completeTaskWithAuthorization({
        operationId,
        taskId: task.id,
        objectiveId: objective.id,
        sourceType: "ui_confirmation",
        nonce: `nonce:${index}`,
        callSurface: "test",
        requestId: operationId,
        idempotencyKey: operationId,
        createdAt: new Date(Date.now() + index).toISOString()
      });
    }

    const seen = [];
    let cursor = null;
    do {
      const page = store.listTaskPage({ objectiveId: objective.id, limit: 3, cursor });
      assert.ok(page.items.length <= 3);
      seen.push(...page.items);
      cursor = page.nextCursor;
      assert.equal(page.hasMore, cursor != null);
    } while (cursor);

    assert.equal(new Set(seen.map((task) => task.id)).size, 8);
    assert.deepEqual(seen.map((task) => task.lifecycle_state === "done"), [
      false, false, false, false, false, true, true, true
    ]);
    assert.equal(store.listTaskPage({ includeCompleted: false, limit: 100 }).items.length, 5);
    const plan = store.selectAll(
      `EXPLAIN QUERY PLAN
       SELECT tasks.*, CASE WHEN tasks.lifecycle_state='done' THEN 1 ELSE 0 END AS completion_rank
       FROM tasks
       WHERE COALESCE(tasks.deletion_status, '') <> 'deleted' AND tasks.objective_id=?
       ORDER BY completion_rank ASC, tasks.updated_at DESC, tasks.id DESC LIMIT ?`,
      [objective.id, 51]
    ).map((row) => row.detail).join("\n");
    assert.match(plan, /idx_tasks_objective_browse_page/);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory pages use an owner-scoped keyset and never return more than requested", async () => {
  const { root, store, objective } = await fixture();
  try {
    for (let index = 0; index < 7; index += 1) {
      store.createMemory({
        ownerType: "objective",
        ownerId: objective.id,
        kind: "fact",
        content: `Memory ${index}`,
        sourceType: "user"
      });
    }
    const first = store.listMemoryPage({
      ownerType: "objective", ownerId: objective.id, limit: 4
    });
    const second = store.listMemoryPage({
      ownerType: "objective", ownerId: objective.id, limit: 4, cursor: first.nextCursor
    });
    assert.equal(first.items.length, 4);
    assert.equal(first.hasMore, true);
    assert.equal(second.items.length, 3);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items].map((memory) => memory.id)).size, 7);
    const plan = store.selectAll(
      `EXPLAIN QUERY PLAN SELECT * FROM memories
       WHERE owner_type=? AND owner_id=?
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ["objective", objective.id, 51]
    ).map((row) => row.detail).join("\n");
    assert.match(plan, /idx_memories_owner_updated_page/);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending archived runtime releases hydrate through the Store row mapper", async () => {
  const { root, store } = await fixture();
  try {
    store.upsertSession({
      id: "session:archived-release",
      title: "Archived release",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete"
    });
    store.db.run("UPDATE sessions SET archived=1 WHERE id=?", ["session:archived-release"]);
    const pending = store.listArchivedSessionsPendingRuntimeRelease({ limit: 10 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "session:archived-release");
    store.markSessionRuntimeReleased(pending[0].id, "test");
    assert.deepEqual(store.listArchivedSessionsPendingRuntimeRelease({ limit: 10 }), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
