import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { WorktreeStartupPreparer } from "../src/application/worktreeStartupPreparer.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { createGitWorkspaceSnapshot } from "../src/utils/gitWorktreeInventory.mjs";

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture({ detached = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-startup-worktree-"));
  const main = join(directory, "main");
  await execFile("git", ["init", "-b", "main", main]);
  await git(main, "config", "user.email", "tests@corptie.local");
  await git(main, "config", "user.name", "Corptie Tests");
  await writeFile(join(main, "tracked.txt"), "source\n");
  await git(main, "add", "tracked.txt");
  await git(main, "commit", "-m", "source");
  const other = join(directory, "other");
  await git(main, "worktree", "add", "-b", "other", other, "HEAD");
  await writeFile(join(other, "dirty.txt"), "preserve\n");
  const target = join(directory, "target");

  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  let snapshot = await createGitWorkspaceSnapshot(main);
  store.upsertGitWorkspaceSnapshot(snapshot);
  const repositoryId = snapshot.repository.id;
  const agent = store.createAgent({ id: "agent:worker", name: "Worker", role: "independentContributor" });
  const objectiveService = new ObjectiveApplicationService({ store });
  const objective = objectiveService.createObjective({
    id: "objective:one", name: "Objective", workspaceIds: [repositoryId], contributorAgentIds: [agent.agentId]
  });
  const workItem = objectiveService.createWorkItem({
    id: "work_item:one", objectiveId: objective.id, title: "Prepare", mainWorkspaceId: repositoryId,
    mainAgentId: agent.agentId
  });
  const preparer = new WorktreeStartupPreparer({
    store,
    ensureWorkspace: async () => {
      await git(main, "worktree", "add", ...(detached ? ["--detach"] : ["-b", "workitem/one"]), target, "HEAD");
      snapshot = await createGitWorkspaceSnapshot(target);
      store.upsertGitWorkspaceSnapshot(snapshot);
      const created = snapshot.worktrees.find((item) =>
        item.branchName === "workitem/one" || (detached && item.isDetached && item.path.endsWith("/target"))
      );
      return {
        worktreeId: created.worktreeId, path: created.path, branchName: created.branchName,
        headOid: created.headOid, isDetached: created.isDetached, inventoryVersion: snapshot.inventoryVersion,
        reused: false
      };
    }
  });
  return { directory, main, other, target, store, preparer, repositoryId, workItem };
}

async function cleanup(f) {
  await f.store.close();
  await rm(f.directory, { recursive: true, force: true });
}

test("creates and verifies exact owned Worktree without changing another dirty Worktree", async () => {
  const f = await fixture();
  try {
    const before = { head: await git(f.other, "rev-parse", "HEAD"), status: await git(f.other, "status", "--porcelain=v1") };
    const allocation = await f.preparer.prepare({
      startupOperationId: "startup:one", workItemId: f.workItem.id,
      repositoryId: f.repositoryId, idempotencyKey: "start:one", workItem: f.workItem
    });
    const after = { head: await git(f.other, "rev-parse", "HEAD"), status: await git(f.other, "status", "--porcelain=v1") };

    assert.deepEqual(after, before);
    assert.equal(allocation.createdByStartupOperationId, "startup:one");
    assert.equal(allocation.headIdentity.kind, "branch");
    assert.equal(allocation.headIdentity.branch, "workitem/one");
    assert.match(allocation.sourceCommitOid, /^[0-9a-f]{40}$/);
    assert.match(allocation.sourceTreeOid, /^[0-9a-f]{40}$/);
    assert.equal(f.store.getGitWorktree(allocation.worktreeId).dedicated, true);
    assert.equal(f.store.getGitWorktree(allocation.worktreeId).createdByStartupOperationId, "startup:one");

    const inspected = await f.preparer.inspect({
      operation: { startup_operation_id: "startup:one" }, allocation
    });
    assert.deepEqual(inspected, allocation);
  } finally { await cleanup(f); }
});

test("preserves detached HEAD identity as a full commit OID", async () => {
  const f = await fixture({ detached: true });
  try {
    const allocation = await f.preparer.prepare({
      startupOperationId: "startup:detached", workItemId: f.workItem.id,
      repositoryId: f.repositoryId, idempotencyKey: "start:detached", workItem: f.workItem
    });
    assert.deepEqual(allocation.headIdentity, { kind: "detached", commitOid: allocation.sourceCommitOid });
  } finally { await cleanup(f); }
});

test("refuses to claim a reused Worktree owned by another startup operation", async () => {
  const f = await fixture();
  try {
    const first = await f.preparer.prepare({
      startupOperationId: "startup:first", workItemId: f.workItem.id,
      repositoryId: f.repositoryId, idempotencyKey: "start:first", workItem: f.workItem
    });
    const second = new WorktreeStartupPreparer({
      store: f.store,
      ensureWorkspace: async () => ({
        worktreeId: first.worktreeId, path: first.canonicalWorktreePath,
        branchName: "workitem/one", headOid: first.sourceCommitOid, reused: true
      })
    });
    await assert.rejects(() => second.prepare({
      startupOperationId: "startup:second", workItemId: f.workItem.id,
      repositoryId: f.repositoryId, idempotencyKey: "start:second", workItem: f.workItem
    }), { code: "START_WORKTREE_COLLISION" });
  } finally { await cleanup(f); }
});

test("revalidates a programmatically prepared Worktree owned by the startup operation", async () => {
  const f = await fixture();
  try {
    await git(f.main, "worktree", "add", "-b", "integration/one", f.target, "HEAD");
    const snapshot = await createGitWorkspaceSnapshot(f.target);
    f.store.upsertGitWorkspaceSnapshot(snapshot);
    const target = snapshot.worktrees.find((item) => item.branchName === "integration/one");
    f.store.db.run(
      `UPDATE git_worktrees SET dedicated=1, created_by_startup_operation_id=?
       WHERE worktree_id=? AND repository_id=?`,
      ["startup:integration", target.worktreeId, f.repositoryId]
    );
    const preparer = new WorktreeStartupPreparer({
      store: f.store,
      ensureWorkspace: async () => assert.fail("operation-owned Store Worktree must be reused")
    });
    const allocation = await preparer.prepare({
      startupOperationId: "startup:integration", workItemId: f.workItem.id,
      repositoryId: f.repositoryId, idempotencyKey: "start:integration",
      workItem: f.store.getWorkItem(f.workItem.id)
    });
    assert.equal(allocation.worktreeId, target.worktreeId);
    assert.equal(allocation.reused, true);
    assert.equal(f.store.getGitWorktree(target.worktreeId).createdByStartupOperationId, "startup:integration");
  } finally { await cleanup(f); }
});
