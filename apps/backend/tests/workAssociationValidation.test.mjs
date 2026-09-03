import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-association-validation-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "settings.json") });
  await store.initialize();
  const contributor = store.createAgent({ id: "agent:contributor", name: "Contributor", role: "independentContributor" });
  return { directory, store, contributor, service: new WorkApplicationService({ store }) };
}

function registerRepository(store, repositoryId) {
  const observedAt = "2026-08-17T00:00:00.000Z";
  store.upsertGitWorkspaceSnapshot({
    repository: { id: repositoryId, commonGitDirCanonicalPath: `/tmp/${repositoryId}/.git`, discoveredAt: observedAt, lastValidatedAt: observedAt },
    worktrees: [{
      worktreeId: `worktree:${repositoryId}`, repositoryId, path: `/tmp/${repositoryId}`,
      canonicalPath: `/tmp/${repositoryId}`, gitDirCanonicalPath: `/tmp/${repositoryId}/.git`,
      isMain: true, availability: "available", headOid: "b".repeat(40), branchRef: "refs/heads/main",
      branchName: "main", isDetached: false, isLocked: false, lockReason: null,
      isPrunable: false, pruneReason: null, inventoryVersion: "inventory:validation", observedAt
    }],
    inventoryVersion: "inventory:validation", observedAt
  });
  return store.getGitRepository(repositoryId);
}

test("Work input exposes only the clean Work schema", async () => {
  const f = await fixture();
  try {
    for (const field of ["idealState", "priority", "targetDate", "workspaceIds", "relatedWorkIds"]) {
      assert.throws(
        () => f.service.createWork({
          name: "Legacy payload", contributorAgentIds: [f.contributor.agentId],
          [field]: field.endsWith("Ids") ? [] : "legacy"
        }),
        { code: "UNKNOWN_FIELD", field }
      );
    }
    assert.equal(f.store.listWorks().length, 0);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Git repository is an optional capability of a Workspace", async () => {
  const f = await fixture();
  try {
    const repository = registerRepository(f.store, "repository:scope");
    assert.ok(repository.workspaceId);
    assert.equal(f.store.getWorkspace(repository.workspaceId).kind, "linkedLocal");
    const work = f.service.createWork({
      name: "Software Work", profile: "software", workspaceId: repository.workspaceId,
      contributorAgentIds: [f.contributor.agentId]
    });
    const task = f.service.createTask({
      workId: work.id, title: "Valid task",
      mainAgentId: f.contributor.agentId
    });
    assert.equal("main_workspace_id" in task, false);
    assert.equal(f.store.getTaskWorkspaceContext(task).repository.id, repository.id);
    assert.throws(
      () => f.service.createTask({ workId: work.id, title: "Foreign repository", mainWorkspaceId: "repository:other" }),
      { code: "UNKNOWN_FIELD", field: "mainWorkspaceId" }
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Work contributor associations remain assignable and in scope", async () => {
  const f = await fixture();
  try {
    const assistant = f.store.createAgent({ name: "Assistant", role: "assistant" });
    assert.throws(
      () => f.service.createWork({ name: "Invalid contributor", contributorAgentIds: [assistant.agentId] }),
      { code: "AGENT_NOT_ASSIGNABLE", field: "contributorAgentIds[0]" }
    );
    const work = f.service.createWork({ name: "Scoped", contributorAgentIds: [f.contributor.agentId] });
    f.service.createTask({ workId: work.id, title: "Owned task", mainAgentId: f.contributor.agentId });
    assert.throws(
      () => f.service.updateWork(work.id, { contributorAgentIds: [] }),
      { code: "WORK_SCOPE_CONFLICT", field: "contributorAgentIds" }
    );
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
