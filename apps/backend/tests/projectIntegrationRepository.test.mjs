import assert from "node:assert/strict";
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
