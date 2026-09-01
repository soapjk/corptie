import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-association-validation-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { directory, store, service: new ObjectiveApplicationService({ store }) };
}

function registerRepository(store, repositoryId, worktreeId) {
  const observedAt = "2026-08-17T00:00:00.000Z";
  store.upsertGitWorkspaceSnapshot({
    repository: {
      id: repositoryId,
      commonGitDirCanonicalPath: `/tmp/${repositoryId}/.git`,
      discoveredAt: observedAt,
      lastValidatedAt: observedAt
    },
    worktrees: [{
      worktreeId,
      repositoryId,
      path: `/tmp/${repositoryId}`,
      canonicalPath: `/tmp/${repositoryId}`,
      gitDirCanonicalPath: `/tmp/${repositoryId}/.git`,
      isMain: true,
      availability: "available",
      headOid: "b".repeat(40),
      branchRef: "refs/heads/main",
      branchName: "main",
      isDetached: false,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null,
      inventoryVersion: "inventory:validation",
      observedAt
    }],
    inventoryVersion: "inventory:validation",
    observedAt
  });
}

test("Objective and Task inputs reject unknown fields and invalid types before SQLite", async () => {
  const { directory, store, service } = await fixture();
  try {
    assert.throws(
      () => service.createObjective({ name: "Strict", workspacePath: "/tmp/repo" }),
      { code: "UNKNOWN_FIELD", field: "workspacePath" }
    );
    assert.equal(store.listObjectives().length, 0);

    assert.throws(
      () => service.createObjective({ name: "Strict", idealState: ["not", "text"] }),
      { code: "INVALID_FIELD_TYPE", field: "idealState", expected: "string" }
    );
    assert.equal(store.listObjectives().length, 0);

    const objective = service.createObjective({ name: "Strict" });
    const objectiveUpdatedAt = store.getObjective(objective.id).updatedAt;
    assert.throws(
      () => store.updateObjective(objective.id, { main_agent_id: "agent:any" }),
      { code: "UNKNOWN_PATCH_FIELD", field: "main_agent_id" }
    );
    assert.equal(store.getObjective(objective.id).name, "Strict");
    assert.equal(store.getObjective(objective.id).updatedAt, objectiveUpdatedAt);

    const item = service.createTask({ objectiveId: objective.id, title: "Strict item" });
    const itemUpdatedAt = store.getTask(item.id).updated_at;
    assert.throws(
      () => store.updateTask(item.id, { assigneeAgentId: "agent:any" }),
      { code: "UNKNOWN_PATCH_FIELD", field: "assigneeAgentId" }
    );
    assert.equal(store.getTask(item.id).title, "Strict item");
    assert.equal(store.getTask(item.id).updated_at, itemUpdatedAt);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository and assignable Agent associations must exist and remain inside Objective scope", async () => {
  const { directory, store, service } = await fixture();
  try {
    const repositoryId = "repository:scope";
    registerRepository(store, repositoryId, "worktree:scope");
    const contributor = store.createAgent({ name: "Contributor" });
    const assistant = store.createAgent({ name: "Assistant", role: "assistant" });

    assert.throws(
      () => service.createObjective({ name: "Bad prefix", workspaceIds: ["worktree:scope"] }),
      { code: "INVALID_WORKSPACE_ID_TYPE", field: "workspaceIds[0]" }
    );
    assert.throws(
      () => service.createObjective({ name: "Missing worktree prefix", workspaceIds: ["missing-worktree:scope"] }),
      { code: "INVALID_WORKSPACE_ID_TYPE", field: "workspaceIds[0]" }
    );
    assert.throws(
      () => service.createObjective({ name: "Missing", workspaceIds: ["repository:missing"] }),
      { code: "WORKSPACE_NOT_FOUND" }
    );
    assert.throws(
      () => service.createObjective({ name: "Assistant", contributorAgentIds: [assistant.agentId] }),
      { code: "AGENT_NOT_ASSIGNABLE" }
    );

    const objective = service.createObjective({
      name: "Scoped",
      workspaceIds: [repositoryId],
      contributorAgentIds: [contributor.agentId]
    });
    assert.throws(
      () => service.createTask({
        objectiveId: objective.id,
        title: "Wrong workspace",
        mainWorkspaceId: "worktree:scope"
      }),
      { code: "INVALID_WORKSPACE_ID_TYPE", field: "mainWorkspaceId" }
    );
    assert.throws(
      () => service.createTask({
        objectiveId: objective.id,
        title: "Missing worktree workspace",
        mainWorkspaceId: "missing-worktree:scope"
      }),
      { code: "INVALID_WORKSPACE_ID_TYPE", field: "mainWorkspaceId" }
    );
    assert.throws(
      () => service.createTask({
        objectiveId: objective.id,
        title: "Wrong agent",
        mainAgentId: assistant.agentId
      }),
      { code: "AGENT_NOT_ASSIGNABLE", field: "mainAgentId" }
    );

    const item = service.createTask({
      objectiveId: objective.id,
      title: "Valid",
      mainWorkspaceId: repositoryId,
      mainAgentId: contributor.agentId
    });
    assert.equal(item.main_workspace_id, repositoryId);
    assert.equal(item.main_agent_id, contributor.agentId);

    assert.throws(
      () => service.updateObjective(objective.id, { workspaceIds: [] }),
      { code: "OBJECTIVE_SCOPE_CONFLICT", field: "workspaceIds" }
    );
    assert.throws(
      () => service.updateObjective(objective.id, { contributorAgentIds: [] }),
      { code: "OBJECTIVE_SCOPE_CONFLICT", field: "contributorAgentIds" }
    );
    assert.deepEqual(store.getObjective(objective.id).workspaceIds, [repositoryId]);
    assert.deepEqual(store.getObjective(objective.id).contributorAgentIds, [contributor.agentId]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Objective relation updates are atomic when another field fails validation", async () => {
  const { directory, store, service } = await fixture();
  try {
    const first = service.createObjective({ name: "First" });
    const second = service.createObjective({ name: "Second" });
    assert.throws(
      () => service.updateObjective(first.id, {
        relatedObjectiveIds: [second.id],
        workspaceIds: ["worktree:unregistered"]
      }),
      { code: "INVALID_WORKSPACE_ID_TYPE" }
    );
    assert.deepEqual(store.getObjective(first.id).relatedObjectiveIds, []);
    assert.deepEqual(store.getObjective(second.id).relatedObjectiveIds, []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical worktree associations migrate safely and unresolved records remain reportable", async () => {
  const { directory, store, service } = await fixture();
  try {
    const repositoryId = "repository:history";
    const worktreeId = "worktree:history";
    registerRepository(store, repositoryId, worktreeId);
    const objective = service.createObjective({ name: "History" });
    const item = service.createTask({ objectiveId: objective.id, title: "History item" });

    store.db.run(
      "UPDATE objectives SET workspace_ids_json = ? WHERE id = ?",
      [JSON.stringify([worktreeId, "worktree:unknown"]), objective.id]
    );
    store.db.run(
      "UPDATE tasks SET main_workspace_id = ? WHERE id = ?",
      [worktreeId, item.id]
    );

    const report = store.auditObjectiveTaskAssociations({ migrate: true });
    assert.deepEqual(store.getObjective(objective.id).workspaceIds, [repositoryId, "worktree:unknown"]);
    assert.equal(store.getTask(item.id).main_workspace_id, repositoryId);
    assert.ok(report.some((entry) => entry.status === "migrated" && entry.receivedValue === worktreeId));
    assert.ok(report.some((entry) => entry.status === "unresolved" && entry.receivedValue === "worktree:unknown"));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
