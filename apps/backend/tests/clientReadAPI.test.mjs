import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientReadAPI } from "../src/application/clientReadAPI.mjs";

test("session activity is an explicit nullable presentation field, never a Provider payload", () => {
  let activityStatus = "Running command";
  const api = new ClientReadAPI({ listSessionPage: () => ({ items: [{ id: "s", title: "Session",
    executionStatus: "running", activityStatus, rawStatus: { secret: "PRIVATE" },
    updatedAt: "now" }], hasMore: false }) });
  const read = () => api.list("sessions", new URLSearchParams()).items[0];
  assert.equal(read().activityStatus, "Running command");
  assert.equal(Object.hasOwn(read(), "rawStatus"), false);
  activityStatus = "Waiting for approval";
  assert.equal(read().activityStatus, "Waiting for approval");
  for (const invalid of [undefined, null, 42, { secret: "PRIVATE" }]) {
    activityStatus = invalid;
    assert.equal(read().activityStatus, null);
    assert.equal(JSON.stringify(read()).includes("PRIVATE"), false);
  }
});

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

test("works advertise avatar availability only; bytes resolve solely from the managed avatars root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-client-avatar-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    const avatarsRoot = join(directory, "avatars");
    const managed = join(avatarsRoot, "works", "work:managed", "avatar.png");
    await mkdir(join(avatarsRoot, "works", "work:managed"), { recursive: true });
    await writeFile(managed, Buffer.from("89504e470d0a1a0a", "hex"));
    const stray = join(directory, "secret.png");
    await writeFile(stray, "PRIVATE");
    const agent = store.createAgent({ id: "agent:test", name: "TestAgent" });
    store.createWork({ id: "work:managed", name: "Managed", contributorAgentIds: [agent.agentId], avatarPath: managed });
    store.createWork({ id: "work:stray", name: "Stray", contributorAgentIds: [agent.agentId], avatarPath: stray });
    store.createWork({ id: "work:plain", name: "Plain", contributorAgentIds: [agent.agentId] });
    const api = new ClientReadAPI(store, { avatarsRoot });
    const items = api.list("works", new URLSearchParams()).items;
    const byId = Object.fromEntries(items.map(item => [item.id, item]));
    assert.equal(byId["work:managed"].hasAvatar, true);
    assert.equal(byId["work:stray"].hasAvatar, true);
    assert.equal(byId["work:plain"].hasAvatar, false);
    assert.equal(JSON.stringify(items).includes(directory), false, "paths never leave the host");
    const resolved = await api.workAvatar("work:managed");
    assert.equal(resolved.path, managed);
    assert.equal(resolved.contentType, "image/png");
    assert.equal(resolved.size, 8);
    assert.match(resolved.etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
    for (const id of ["work:stray", "work:plain", "work:missing"]) {
      await assert.rejects(api.workAvatar(id), error => error.status === 404);
    }
    await assert.rejects(api.workAvatar(""), error => error.status === 400);
    await assert.rejects(api.workAvatar("work:managed/../../secret"), error => error.status === 404);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("tasks expose pending scheduled wake and deletion presentation flags without extra per-row queries", () => {
  let wakeCalls = 0;
  const api = new ClientReadAPI({
    listTaskPage: () => ({ items: [
      { id: "task:wake", title: "A", work_id: "w", lifecycle_state: "active", execution_status: "idle", current_session_id: null, updated_at: "1" },
      { id: "task:deleting", title: "B", work_id: "w", lifecycle_state: "active", execution_status: "idle", current_session_id: null, deletion_status: "deleting", updated_at: "1" },
      { id: "task:failed", title: "C", work_id: "w", lifecycle_state: "active", execution_status: "idle", current_session_id: null, deletion_status: "delete_failed", updated_at: "1" },
      { id: "task:plain", title: "D", work_id: "w", lifecycle_state: "active", execution_status: "idle", current_session_id: null, deletion_status: "bogus", updated_at: "1" },
      { id: "task:running", title: "E", work_id: "w", lifecycle_state: "active", execution_status: "idle", current_session_id: "session:active", updated_at: "1" }
    ], hasMore: false }),
    listTaskIdsWithPendingScheduledWake: () => { wakeCalls += 1; return ["task:wake"]; },
    getSession: id => id === "session:active" ? { id, executionStatus: "running", archived: false } : null
  });
  const items = api.list("tasks", new URLSearchParams()).items;
  assert.equal(wakeCalls, 1);
  assert.deepEqual(items.map(item => [item.id, item.hasPendingScheduledWake, item.deletionStatus, item.executionStatus]), [
    ["task:wake", true, null, "idle"],
    ["task:deleting", false, "deleting", "idle"],
    ["task:failed", false, "delete_failed", "idle"],
    ["task:plain", false, null, "idle"],
    ["task:running", false, null, "running"]
  ]);
});

test("sessions carry the desktop read-receipt cursors from one batched query", () => {
  let cursorCalls = 0;
  const api = new ClientReadAPI({
    listSessionPage: () => ({ items: [
      { id: "s1", title: "A", executionStatus: "complete", updatedAt: "1" },
      { id: "s2", title: "B", executionStatus: "complete", updatedAt: "1" }
    ], hasMore: false }),
    listSessionMessageCursors: ids => { cursorCalls += 1; assert.deepEqual(ids, ["s1", "s2"]);
      return new Map([["s1", { lastAgentMessageSequence: 9, lastReadMessageSequence: 4 }]]); }
  });
  const items = api.list("sessions", new URLSearchParams()).items;
  assert.equal(cursorCalls, 1);
  assert.deepEqual(items.map(item => [item.id, item.lastAgentMessageSequence, item.lastReadMessageSequence]),
    [["s1", 9, 4], ["s2", 0, 0]]);
});
