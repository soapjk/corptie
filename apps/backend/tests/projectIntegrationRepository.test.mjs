import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("integration run and items roll back together on invalid items and enclosing transaction failure", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-integration-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const item = { worktreeId: "worktree:test", taskId: "task:test", sourceHeadOid: "abc" };
    const input = { id: "integration:test", repositoryId: "repository:test", workId: "work:test",
      mainHeadBefore: "def", items: [item] };
    const revision = store.stateRevision();
    assert.throws(() => store.createProjectIntegrationRun({ ...input, items: [item, item] }), /UNIQUE/);
    assert.equal(store.getProjectIntegrationRun(input.id), null);
    assert.deepEqual(store.selectAll("SELECT * FROM project_integration_items"), []);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    const failure = new Error("enclosing transaction failed");
    assert.throws(() => store.runInTransaction(() => {
      store.createProjectIntegrationRun(input);
      store.updateProjectIntegrationItem(input.id, item.worktreeId, { status: "conflict", conflictFiles: ["source.mjs"] });
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getProjectIntegrationRun(input.id), null);
    assert.equal(store.stateRevision(), revision);
    assert.equal(notifications, 0);
    store.runInTransaction(() => {
      store.createProjectIntegrationRun(input);
      store.updateProjectIntegrationItem(input.id, item.worktreeId, { status: "merged", mergedMainHead: "ghi" });
      store.updateProjectIntegrationRun(input.id, { status: "completed", mainHeadAfter: "ghi" });
    });
    assert.equal(notifications, 1);
    const result = store.getLatestProjectIntegrationRun(input.repositoryId, input.workId);
    assert.equal(result.status, "completed");
    assert.equal(result.items[0].mergedMainHead, "ghi");
    assert.deepEqual(store.listProjectIntegrationRuns(1), [result]);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});

test("durable Worktree execution creation is idempotent and repository-exclusive", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-worktree-integration-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    store.upsertGitWorkspaceSnapshot({
      observedAt: "2026-10-01T00:00:00.000Z",
      inventoryVersion: "inventory:1",
      repository: {
        id: "repository:jobs", commonGitDirCanonicalPath: "/repo/.git",
        discoveredAt: "2026-10-01T00:00:00.000Z", lastValidatedAt: "2026-10-01T00:00:00.000Z"
      },
      worktrees: []
    });
    const input = {
      repositoryId: "repository:jobs", planFingerprint: "plan:one", fingerprintVersion: 1,
      idempotencyKey: "confirm:one", startRequestFingerprint: "request:one",
      startRequestFingerprintVersion: 1, status: "queued", phase: "queued",
      confirmedAt: "2026-10-01T00:00:01.000Z",
      details: { plan: { items: [] }, audit: [] }
    };
    const created = store.createWorktreeIntegrationJobIdempotently(input);
    const repeated = store.createWorktreeIntegrationJobIdempotently(input);
    assert.equal(repeated.id, created.id);
    assert.equal(repeated.idempotencyKey, input.idempotencyKey);
    assert.equal(repeated.fingerprintVersion, 1);
    assert.equal(repeated.startRequestFingerprint, "request:one");
    assert.equal(repeated.startRequestFingerprintVersion, 1);
    assert.throws(() => store.createWorktreeIntegrationJobIdempotently({
      ...input, planFingerprint: "plan:different", startRequestFingerprint: "request:different"
    }), (error) => error.code === "IDEMPOTENCY_KEY_REUSED");
    assert.throws(() => store.createWorktreeIntegrationJobIdempotently({
      ...input, idempotencyKey: "confirm:two", planFingerprint: "plan:two",
      startRequestFingerprint: "request:two"
    }), (error) => error.code === "INTEGRATION_JOB_ACTIVE");

    store.updateWorktreeIntegrationJob(created.id, {
      status: "completed", phase: "completed", completedAt: "2026-10-01T00:00:02.000Z"
    });
    const next = store.createWorktreeIntegrationJobIdempotently({
      ...input, idempotencyKey: "confirm:two", planFingerprint: "plan:two",
      startRequestFingerprint: "request:two"
    });
    assert.notEqual(next.id, created.id);
    assert.equal(store.getWorktreeIntegrationJobByIdempotencyKey(
      "repository:jobs", "confirm:two"
    ).id, next.id);

    const legacyReview = store.createWorktreeIntegrationJob({
      repositoryId: "repository:jobs", planFingerprint: "legacy:review",
      status: "awaiting_confirmation", details: { plan: { items: [] }, audit: [] }
    });
    assert.equal(legacyReview.status, "awaiting_confirmation");
    assert.throws(() => store.createWorktreeIntegrationJob({
      repositoryId: "repository:jobs", planFingerprint: "direct:active",
      status: "paused", details: { plan: { items: [] }, audit: [] }
    }), /UNIQUE constraint failed: worktree_integration_jobs\.repository_id/);
  } finally {
    await store.close();
  }
});

test("active Worktree execution index migrates once and remains stable on restart", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-integration-index-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  let store = new CorptieStore({ dbPath, manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    store.db.run(
      "DELETE FROM data_migrations WHERE migration_id = ?",
      ["worktree-integration-active-index-v1"]
    );
    store.db.run("DROP INDEX idx_worktree_integration_jobs_active");
    store.db.run(`CREATE UNIQUE INDEX idx_worktree_integration_jobs_active
      ON worktree_integration_jobs(repository_id)
      WHERE status = 'queued'`);
    await store.close();

    store = new CorptieStore({ dbPath, manageProcessEnvironment: false });
    await store.initialize({ resolveDataPath: false });
    const migrated = store.selectOne(
      "SELECT sql, rootpage FROM sqlite_master WHERE type = 'index' AND name = ?",
      ["idx_worktree_integration_jobs_active"]
    );
    assert.match(migrated.sql, /'queued', 'running', 'paused', 'cancellation_requested', 'replanning'/);
    assert.ok(store.selectOne(
      "SELECT migration_id FROM data_migrations WHERE migration_id = ?",
      ["worktree-integration-active-index-v1"]
    ));
    const rootpage = migrated.rootpage;
    await store.close();

    store = new CorptieStore({ dbPath, manageProcessEnvironment: false });
    await store.initialize({ resolveDataPath: false });
    assert.equal(store.selectOne(
      "SELECT rootpage FROM sqlite_master WHERE type = 'index' AND name = ?",
      ["idx_worktree_integration_jobs_active"]
    ).rootpage, rootpage);
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration rejects pre-existing duplicate active Worktree executions with actionable details", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-integration-migration-"));
  const dbPath = join(directory, "corptie.sqlite");
  let store = new CorptieStore({ dbPath, manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    store.upsertGitWorkspaceSnapshot({
      observedAt: "2026-10-01T00:00:00.000Z",
      inventoryVersion: "inventory:duplicates",
      repository: {
        id: "repository:duplicates", commonGitDirCanonicalPath: "/duplicates/.git",
        discoveredAt: "2026-10-01T00:00:00.000Z", lastValidatedAt: "2026-10-01T00:00:00.000Z"
      },
      worktrees: []
    });
    store.db.run("DROP INDEX idx_worktree_integration_jobs_active");
    for (const [id, status] of [["job:queued", "queued"], ["job:paused", "paused"]]) {
      store.createWorktreeIntegrationJob({
        id, repositoryId: "repository:duplicates", planFingerprint: `plan:${id}`,
        status, details: { plan: { items: [] }, audit: [] }
      });
    }
    await store.close();

    store = new CorptieStore({ dbPath, manageProcessEnvironment: false });
    await assert.rejects(
      () => store.initialize({ resolveDataPath: false }),
      (error) => error.code === "WORKTREE_INTEGRATION_ACTIVE_ROWS_CONFLICT"
        && error.message.includes("repository:duplicates")
        && error.message.includes("job:queued")
        && error.message.includes("job:paused")
    );
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
