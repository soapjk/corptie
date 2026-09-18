import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientReadAPI } from "../src/application/clientReadAPI.mjs";

test("real Store inventory is paginated and excludes private implementation fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-client-inventory-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    const agent = store.createAgent({ id: "agent:test", name: "TestAgent" });
    for (const suffix of ["One", "Two"]) {
      const work = store.createWork({ id: `work:${suffix}`, name: `Work${suffix}`, contributorAgentIds: [agent.agentId] });
      const task = store.createTask({ id: `task:${suffix}`, workId: work.id, title: `Task${suffix}`,
        mainAgentId: agent.agentId, description: "PRIVATE_IMPLEMENTATION_MARKER" });
      store.createSession({ id: `session:${suffix}`, title: `Session${suffix}`, sessionKind: "worker",
        workId: work.id, taskId: task.id, agentId: agent.agentId, status: "complete", summary: "PRIVATE_IMPLEMENTATION_MARKER" });
    }
    const api = new ClientReadAPI(store);
    for (const kind of ["works", "tasks", "sessions"]) {
      const first = api.list(kind, new URLSearchParams("limit=1"));
      assert.equal(first.items.length, 1);
      assert.equal(first.hasMore, true);
      const second = api.list(kind, new URLSearchParams({ limit: "1", cursor: first.nextCursor }));
      assert.notEqual(second.items[0].id, first.items[0].id);
      assert.equal(second.hasMore, false);
      assert.equal(JSON.stringify(first).includes("PRIVATE_IMPLEMENTATION_MARKER"), false);
      for (const row of first.items) {
        for (const field of ["external", "workspacePath", "avatarPath", "description", "agentId", "capabilities"]) {
          assert.equal(Object.hasOwn(row, field), false);
        }
      }
      for (const query of ["limit=101", "limit=0", "limit=-1", "cursor=bad", "limit=1&limit=2", "unknown=a"]) {
        assert.throws(() => api.list(kind, new URLSearchParams(query)), error => error.status === 400);
      }
    }
    const workCursor = api.list("works", new URLSearchParams("limit=1")).nextCursor;
    assert.throws(() => api.list("sessions", new URLSearchParams({ cursor: workCursor })), { code: "INVALID_CURSOR" });

    const task = store.listTaskPage({ limit: 10, includeCompleted: true }).items[0];
    store.db.run("UPDATE tasks SET current_session_id = ? WHERE id = ?", ["session:One", task.id]);
    store.db.run("UPDATE sessions SET archived = 1 WHERE id = ?", ["session:One"]);
    const projected = api.list("tasks", new URLSearchParams("limit=10")).items.find(item => item.id === task.id);
    assert.equal(projected.currentSessionId, null, "an effectively archived worker Session is never advertised as openable");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
