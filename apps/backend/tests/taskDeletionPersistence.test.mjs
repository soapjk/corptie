import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskDeletionService } from "../src/application/taskDeletionService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const localUser = { type: "user", id: "user:local-macos" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-task-delete-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:deletion", name: "Deletion", role: "independentContributor" });
  store.createWork({ id: "work:delete", name: "Deletion", contributorAgentIds: [agent.agentId] });
  store.createTask({ id: "task:delete", workId: "work:delete", title: "Deleteme", mainAgentId: agent.agentId });
  const changed = [];
  const deletion = new TaskDeletionService({
    store,
    authorize: ({ actor }) => actor?.type === "user" && actor.id === "user:local-macos",
    inspectWorktree: async () => ({ status: "none", worktree: null, blocker: null }),
    removeWorktree: async () => assert.fail("metadata-only deletion must not clean a Worktree"),
    deleteSession: async (sessionId) => store.deleteSession(sessionId),
    handleArtifacts: async ({ artifacts, disposition }) => {
      for (const artifact of artifacts ?? []) {
        if (disposition === "work") {
          store.updateArtifact(artifact.artifactId, {
            visibility: "work_private", scope: "work", boundTaskId: null, boundSessionId: null
          });
        } else if (disposition === "delete") {
          store.updateArtifact(artifact.artifactId, {
            status: "revoked", boundTaskId: null, boundSessionId: null
          });
        }
      }
      return { disposition, artifactIds: (artifacts ?? []).map((artifact) => artifact.artifactId) };
    },
    onChanged: (type, payload) => changed.push({ type, payload })
  });
  return { directory, dbPath, configPath, store, deletion, changed };
}

test("authorized deletion removes Task from detail and list and remains deleted after Store reload", async () => {
  const f = await fixture();
  try {
    const result = await f.deletion.delete("task:delete", { mode: "safe" }, localUser);
    assert.equal(result.ok, true);
    assert.equal(f.store.getTask("task:delete"), null);
    assert.equal(f.store.listTasks().some((item) => item.id === "task:delete"), false);
    assert.deepEqual(f.changed, [{
      type: "TaskChanged",
      payload: { action: "deleted", entity: { id: "task:delete" } }
    }]);

    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();
    assert.equal(f.store.getTask("task:delete"), null);
    assert.equal(f.store.listTasks().some((item) => item.id === "task:delete"), false);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("deletion request returns a durable operation before slow cleanup completes", async () => {
  const f = await fixture();
  try {
    let releaseCleanup;
    const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
    f.deletion.deleteSession = async (sessionId) => {
      await cleanupGate;
      return f.store.deleteSession(sessionId);
    };
    f.store.createSession({
      id: "session:slow", title: "Slow", provider: "codex-app-server",
      agentId: "agent:deletion", sessionKind: "worker", workId: "work:delete",
      taskId: "task:delete", cwd: f.directory, deferTaskProjection: true
    });
    const accepted = await f.deletion.request("task:delete", {
      mode: "safe", idempotencyKey: "delete:slow"
    }, localUser);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.operation.state, "queued");
    assert.equal(f.store.getTask("task:delete").deletion_status, "deleting");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.deletion.getOperation(accepted.operation.operationId).state, "running");
    releaseCleanup();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (f.deletion.getOperation(accepted.operation.operationId).state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.deletion.getOperation(accepted.operation.operationId).state, "succeeded");
    const replay = await f.deletion.request("task:delete", {
      mode: "safe", idempotencyKey: "delete:slow"
    }, localUser);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.operation.operationId, accepted.operation.operationId);
    assert.equal(replay.operation.state, "succeeded");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a bound Artifact can move to Work scope while deleting its Task", async () => {
  const f = await fixture();
  try {
    f.store.createArtifactMetadata({
      artifactId: "artifact:blocker",
      workId: "work:delete",
      title: "Required evidence",
      visibility: "task_private",
      boundTaskId: "task:delete",
      actorId: localUser.id,
      createdAt: "2026-08-26T00:00:00.000Z"
    });
    await f.deletion.delete("task:delete", {
      mode: "safe", artifactDisposition: "work"
    }, localUser);
    const artifact = f.store.getArtifact("artifact:blocker");
    assert.equal(artifact.visibility, "work_private");
    assert.equal(artifact.scope, "work");
    assert.equal(artifact.boundTaskId, null);
    assert.equal(f.store.getTask("task:delete"), null);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("deletion removes associated Worker Session history instead of detaching it", async () => {
  const f = await fixture();
  try {
    f.store.upsertSession({
      id: "session:delete",
      title: "Delete history",
      agent: "Delete",
      agentId: "agent:deletion",
      provider: "codex-app-server",
      status: "complete",
      sessionKind: "worker",
      workId: "work:delete",
      taskId: "task:delete"
    });
    f.store.upsertTimelineItemProjection("session:delete", {
      id: "message:delete",
      type: "userMessage",
      text: "private history",
      createdAt: "2026-08-27T00:00:00.000Z"
    });

    const plan = await f.deletion.inspect("task:delete", localUser);
    assert.equal(plan.associatedSessionCount, 1);
    const result = await f.deletion.delete("task:delete", { mode: "safe" }, localUser);

    assert.deepEqual(result.resources.deletedSessionIds, ["session:delete"]);
    assert.equal(f.store.getSession("session:delete"), null);
    assert.equal(f.store.selectOne("SELECT id FROM session_items WHERE session_id=?", ["session:delete"]), null);
    assert.equal(f.store.getTask("task:delete"), null);
    assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("deletion retires a Task while preserving a legacy immutable cancellation audit", async () => {
  const f = await fixture();
  try {
    f.store.db.run(`INSERT INTO task_cancellation_operations (
      operation_id, task_id, work_id, source_type, actor_session_id,
      authority_type, authority_id, reason, idempotency_key, input_fingerprint,
      resource_version_before, resource_version_after, canceled_at, created_at
    ) VALUES ('legacy-cancellation', 'task:delete', 'work:delete', 'legacy', NULL,
      'user', 'user:local-macos', 'Legacy audit', 'legacy-cancellation', 'fingerprint',
      1, 2, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`);

    const result = await f.deletion.delete("task:delete", { mode: "safe" }, localUser);

    assert.equal(result.ok, true);
    assert.equal(f.store.getTask("task:delete"), null);
    assert.equal(f.store.listTasks().some((item) => item.id === "task:delete"), false);
    assert.equal(
      f.store.selectOne("SELECT deletion_status FROM tasks WHERE id=?", ["task:delete"]).deletion_status,
      "deleted"
    );
    assert.equal(
      f.store.selectOne("SELECT reason FROM task_cancellation_operations WHERE operation_id='legacy-cancellation'").reason,
      "Legacy audit"
    );
    assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"), []);

    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();
    assert.equal(f.store.getTask("task:delete"), null);
    assert.ok(f.store.selectOne("SELECT operation_id FROM task_cancellation_operations WHERE operation_id='legacy-cancellation'"));
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
