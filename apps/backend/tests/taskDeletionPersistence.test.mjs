import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskDeletionService } from "../src/application/taskDeletionService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const localUser = { type: "user", id: "user:local-macos" };

test("durable deletion ignores client target overrides and preserves authenticated actor", async () => {
  const f = await fixture();
  try {
    const accepted = await f.deletion.request("task:delete", {
      idempotencyKey: "delete:bound", target: { taskId: "task:other", path: "/unrelated" },
      actor: { type: "user", id: "user:forged" }
    }, localUser);
    await f.deletion.inFlight.get(accepted.operation.operationId);
    const operation = f.deletion.getOperation(accepted.operation.operationId);
    assert.equal(operation.state, "succeeded");
    assert.equal(operation.input.target.taskId, "task:delete");
    assert.equal(operation.input.target.path, null);
    assert.deepEqual(operation.input.actor, localUser);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("legacy recovery resolves the same Task without requesting confirmation", async () => {
  const f = await fixture();
  try {
    const old = f.store.beginTaskDeletionOperation("task:delete", { mode: "force", actor: localUser }, "legacy:unbound");
    assert.equal(f.deletion.recoverInterruptedDeletions(), 1);
    await f.deletion.inFlight.get(old.operationId);
    const result = f.deletion.getOperation(old.operationId);
    assert.equal(result.state, "succeeded");
    assert.equal(result.errorCode, null);
    assert.equal(f.store.getTask("task:delete"), null);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("leaf retirement survives reload and retains parent identity without retiring the parent", async () => {
  const f = await fixture();
  try {
    const parent = f.store.getTask("task:delete");
    f.store.createTask({ id: "task:child", workId: parent.work_id, title: "Child", parentTaskId: parent.id }, {},
      { expectedParentResourceVersion: parent.resource_version });
    const before = f.store.getTask(parent.id).hierarchy_revision;
    const accepted = await f.deletion.request("task:child", { idempotencyKey: "leaf:retire" }, localUser);
    await f.deletion.inFlight.get(accepted.operation.operationId);
    assert.equal(f.deletion.getOperation(accepted.operation.operationId).state, "succeeded");
    assert.ok(f.store.getTask(parent.id));
    assert.equal(f.store.getTask(parent.id).hierarchy_revision, before + 1);
    assert.equal(f.store.hasTaskChildren(parent.id), false);
    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();
    assert.equal(f.store.getTask("task:child"), null);
    assert.equal(f.store.selectOne("SELECT parent_task_id FROM tasks WHERE id='task:child'").parent_task_id, parent.id);
    assert.ok(f.store.getTask(parent.id));
    assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"), []);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

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
      taskId: "task:delete", cwd: f.directory, deferTaskProjection: true, status: "idle"
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


test("root deletion cascades real child records and preserves unrelated Tasks across retry",async()=>{
  const f=await fixture();
  try {
    const parent=f.store.getTask("task:delete");
    f.store.createTask({id:"task:cascade",workId:parent.work_id,title:"Child",parentTaskId:parent.id},{},{});
    f.store.createTask({id:"task:unrelated",workId:parent.work_id,title:"Unrelated"},{},{});
    const accepted=await f.deletion.request(parent.id,{idempotencyKey:"cascade"},localUser);
    await f.deletion.inFlight.get(accepted.operation.operationId);
    assert.equal(f.deletion.getOperation(accepted.operation.operationId).state,"succeeded");
    assert.equal(f.store.getTask("task:cascade"),null);
    assert.equal(f.store.getTask(parent.id),null);
    assert.ok(f.store.getTask("task:unrelated"));
    assert.equal((await f.deletion.request(parent.id,{idempotencyKey:"cascade"},localUser)).idempotentReplay,true);
    assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"),[]);
  } finally {await f.store.close();await rm(f.directory,{recursive:true,force:true});}
});


test("same-key failed cleanup resumes once, preserves intent and skips removed Worktree", async () => {
  const f = await fixture();
  try {
    let removals = 0;
    let transfers = 0;
    f.deletion.inspectWorktree = async () => ({ status: "available", worktree: { worktreeId: "tree:one", path: f.directory, mergedIntoMain: true } });
    f.deletion.removeWorktree = async () => { removals++; return { worktreeRemoved: true }; };
    f.deletion.handleArtifacts = async () => {
      if (++transfers === 1) throw Object.assign(new Error("transfer interrupted"), { code: "ARTIFACT_IDEMPOTENCY_CONFLICT" });
      return { disposition: "work", artifactIds: [] };
    };
    const input = { idempotencyKey: "resume:one", artifactDisposition: "work" };
    const first = await f.deletion.request("task:delete", input, localUser);
    await f.deletion.inFlight.get(first.operation.operationId);
    const failed = f.deletion.getOperation(first.operation.operationId);
    assert.equal(failed.state, "failed");
    assert.equal(removals, 1);
    await assert.rejects(f.deletion.request("task:delete", input, { type: "user", id: "someone-else" }), { code: "TASK_DELETE_FORBIDDEN" });
    await assert.rejects(f.deletion.request("task:delete", { ...input, artifactDisposition: "delete" }, localUser), { code: "TASK_DELETE_IDEMPOTENCY_CONFLICT" });
    f.deletion.authorize = () => false;
    await assert.rejects(f.deletion.request("task:delete", input, localUser), { code: "TASK_DELETE_FORBIDDEN" });
    f.deletion.authorize = () => true;
    const retries = await Promise.all([f.deletion.request("task:delete", input, localUser), f.deletion.request("task:delete", input, localUser)]);
    assert.ok(retries.every(r => r.operation.operationId === first.operation.operationId));
    await f.deletion.inFlight.get(first.operation.operationId);
    const done = f.deletion.getOperation(first.operation.operationId);
    assert.equal(done.state, "succeeded");
    assert.equal(done.attempt, failed.attempt + 1);
    assert.equal(removals, 1);
    assert.equal(transfers, 2);
    assert.equal(done.input.artifactDisposition, "work");
    assert.equal(f.store.getTask("task:delete"), null);
    const replay = await f.deletion.request("task:delete", input, localUser);
    assert.equal(replay.operation.state, "succeeded");
    assert.equal(transfers, 2);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});
