import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkItemDeletionService } from "../src/application/workItemDeletionService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const localUser = { type: "user", id: "user:local-macos" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-item-delete-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  await store.initialize();
  store.createObjective({ id: "objective:delete", name: "Deletion" });
  store.createWorkItem({ id: "work_item:delete", objectiveId: "objective:delete", title: "Delete me" });
  const changed = [];
  const deletion = new WorkItemDeletionService({
    store,
    authorize: ({ actor }) => actor?.type === "user" && actor.id === "user:local-macos",
    inspectWorktree: async () => ({ status: "none", worktree: null, blocker: null }),
    removeWorktree: async () => assert.fail("metadata-only deletion must not clean a Worktree"),
    deleteSession: async (sessionId) => store.deleteSession(sessionId),
    onChanged: (type, payload) => changed.push({ type, payload })
  });
  return { directory, dbPath, configPath, store, deletion, changed };
}

test("authorized deletion removes WorkItem from detail and list and remains deleted after Store reload", async () => {
  const f = await fixture();
  try {
    const result = await f.deletion.delete("work_item:delete", { mode: "safe" }, localUser);
    assert.equal(result.ok, true);
    assert.equal(f.store.getWorkItem("work_item:delete"), null);
    assert.equal(f.store.listWorkItems().some((item) => item.id === "work_item:delete"), false);
    assert.deepEqual(f.changed, [{
      type: "WorkItemChanged",
      payload: { action: "deleted", entity: { id: "work_item:delete" } }
    }]);

    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();
    assert.equal(f.store.getWorkItem("work_item:delete"), null);
    assert.equal(f.store.listWorkItems().some((item) => item.id === "work_item:delete"), false);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a retained Artifact produces an actionable blocker and leaves all records unchanged", async () => {
  const f = await fixture();
  try {
    f.store.createArtifactMetadata({
      artifactId: "artifact:blocker",
      objectiveId: "objective:delete",
      title: "Required evidence",
      visibility: "work_item_private",
      boundWorkItemId: "work_item:delete",
      actorId: localUser.id,
      createdAt: "2026-08-26T00:00:00.000Z"
    });
    await assert.rejects(
      f.deletion.delete("work_item:delete", { mode: "safe" }, localUser),
      (error) => error.code === "WORK_ITEM_DELETE_BLOCKED"
        && error.statusCode === 409
        && error.deletion.blockers[0].code === "WORK_ITEM_HAS_BOUND_ARTIFACTS"
    );
    assert.ok(f.store.getWorkItem("work_item:delete"));
    assert.ok(f.store.getArtifact("artifact:blocker"));
    assert.equal(f.store.getWorkItem("work_item:delete").deletion_status, null);
    assert.deepEqual(f.changed, []);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("deletion removes associated Worker Session history instead of detaching it", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent({ id: "agent:delete", name: "Delete", role: "independentContributor" });
    f.store.updateObjective("objective:delete", { contributorAgentIds: [agent.agentId] });
    f.store.upsertSession({
      id: "session:delete",
      title: "Delete history",
      agent: "Delete",
      agentId: agent.agentId,
      provider: "codex-app-server",
      status: "complete",
      sessionKind: "worker",
      objectiveId: "objective:delete",
      workItemId: "work_item:delete"
    });
    f.store.upsertTimelineItemProjection("session:delete", {
      id: "message:delete",
      type: "userMessage",
      text: "private history",
      createdAt: "2026-08-27T00:00:00.000Z"
    });

    const plan = await f.deletion.inspect("work_item:delete", localUser);
    assert.equal(plan.associatedSessionCount, 1);
    const result = await f.deletion.delete("work_item:delete", { mode: "safe" }, localUser);

    assert.deepEqual(result.resources.deletedSessionIds, ["session:delete"]);
    assert.equal(f.store.getSession("session:delete"), null);
    assert.equal(f.store.selectOne("SELECT id FROM session_items WHERE session_id=?", ["session:delete"]), null);
    assert.equal(f.store.getWorkItem("work_item:delete"), null);
    assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("deletion retires a WorkItem while preserving a legacy immutable cancellation audit", async () => {
  const f = await fixture();
  try {
    f.store.db.run(`INSERT INTO work_item_cancellation_operations (
      operation_id, work_item_id, objective_id, source_type, actor_session_id,
      authority_type, authority_id, reason, idempotency_key, input_fingerprint,
      resource_version_before, resource_version_after, canceled_at, created_at
    ) VALUES ('legacy-cancellation', 'work_item:delete', 'objective:delete', 'legacy', NULL,
      'user', 'user:local-macos', 'Legacy audit', 'legacy-cancellation', 'fingerprint',
      1, 2, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`);

    const result = await f.deletion.delete("work_item:delete", { mode: "safe" }, localUser);

    assert.equal(result.ok, true);
    assert.equal(f.store.getWorkItem("work_item:delete"), null);
    assert.equal(f.store.listWorkItems().some((item) => item.id === "work_item:delete"), false);
    assert.equal(
      f.store.selectOne("SELECT deletion_status FROM work_items WHERE id=?", ["work_item:delete"]).deletion_status,
      "deleted"
    );
    assert.equal(
      f.store.selectOne("SELECT reason FROM work_item_cancellation_operations WHERE operation_id='legacy-cancellation'").reason,
      "Legacy audit"
    );
    assert.deepEqual(f.store.selectAll("PRAGMA foreign_key_check"), []);

    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();
    assert.equal(f.store.getWorkItem("work_item:delete"), null);
    assert.ok(f.store.selectOne("SELECT operation_id FROM work_item_cancellation_operations WHERE operation_id='legacy-cancellation'"));
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("startup migration removes failed canceled deletions and normalizes every other legacy status", async () => {
  const f = await fixture();
  try {
    f.store.createWorkItem({ id: "work_item:legacy-blocked", objectiveId: "objective:delete", title: "Legacy blocked" });
    f.store.db.run("DROP TRIGGER work_item_status_insert_guard");
    f.store.db.run("DROP TRIGGER work_item_status_update_guard");
    f.store.db.run("UPDATE work_items SET status='canceled', deletion_status='delete_failed' WHERE id='work_item:delete'");
    f.store.db.run("UPDATE work_items SET status='blocked' WHERE id='work_item:legacy-blocked'");
    f.store.db.run("DELETE FROM data_migrations WHERE migration_id='work-item-three-state-model-v1'");

    await f.store.close();
    f.store = new CorptieStore({ dbPath: f.dbPath, configPath: f.configPath });
    await f.store.initialize();

    assert.equal(f.store.getWorkItem("work_item:delete"), null);
    assert.equal(
      f.store.selectOne("SELECT deletion_status FROM work_items WHERE id='work_item:delete'").deletion_status,
      "deleted"
    );
    assert.equal(f.store.getWorkItem("work_item:legacy-blocked").status, "todo");
    assert.deepEqual(new Set(f.store.listWorkItems().map((item) => item.status)), new Set(["todo"]));
    assert.throws(
      () => f.store.db.run("UPDATE work_items SET status='canceled' WHERE id='work_item:legacy-blocked'"),
      /WORK_ITEM_STATUS_INVALID/
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
