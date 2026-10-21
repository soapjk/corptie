import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, rm, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { join } from "node:path";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";
import { inspectGitWorkspace } from "../src/utils/gitWorktreeInventory.mjs";
import { WorktreeIntegrationJobService } from "../src/application/worktreeIntegrationJobService.mjs";
import { ClientWorktreeManagementAPI } from "../src/application/clientWorktreeManagementAPI.mjs";

test("explicit Worktree diagnosis is read-only; repair affects only the selected authoritative tree", async t => {
  const source = await createProjectCodeFixture();
  t.after(() => rm(source.directory, { recursive: true, force: true }));
  const feature = join(source.directory, "feature");
  await promisify(execFile)("git", ["-C", source.directory, "worktree", "add", "-b", "feature", feature]);
  const identity = await inspectGitWorkspace(feature);
  const repository = { id: identity.repositoryId };
  const inventory = { worktrees: [{ worktreeId: identity.worktreeId, path: identity.canonicalPath, isMain: false, availability: "available" }] };
  const service = new WorktreeIntegrationJobService({ store: { getGitRepository: id => id === repository.id ? repository : null,
    getWorktreeIntegrationJobByIdempotencyKey() { throw new Error("Unexpected job read"); },
    createWorktreeIntegrationJobIdempotently() { throw new Error("Unexpected job creation"); } },
    ...Object.fromEntries(["inspectCommitProtection", "commitChanges", "inspectCommitPolicyFiles", "ignoreCommitPolicyFile",
      "deleteCommitPolicyFile", "convertCommitPolicyFileToArtifact", "allowCommitPolicyFileTracking", "recoverGitOperation",
      "mergeSource", "abortMerge", "prepareConflictResolution", "inspectConflictResolution", "launchConflictResolution"]
      .map(name => [name, async () => { throw new Error(`Unexpected ${name}`); }])),
    inspectRepository: async () => inventory });
  const api = new ClientWorktreeManagementAPI({ worktrees: service });
  assert.equal((await api.localState(repository.id, identity.worktreeId)).state, "missing");
  await assert.rejects(lstat(join(feature, ".corptie")), { code: "ENOENT" });
  assert.equal((await api.localState(repository.id, identity.worktreeId, {})).state, "ready");
  assert.equal(await readFile(join(feature, ".corptie/.gitignore"), "utf8"), "*\n");
  await assert.rejects(lstat(join(source.directory, ".corptie")), { code: "ENOENT" });
  await assert.rejects(api.localState(repository.id, identity.worktreeId, { path: source.directory }), { code: "INVALID_WORK_COMMAND" });
  await assert.rejects(api.localState("missing", identity.worktreeId), { code: "REPOSITORY_NOT_FOUND" });
  inventory.worktrees[0].worktreeId = "foreign";
  await assert.rejects(api.localState(repository.id, "foreign", {}), { code: "WORKTREE_IDENTITY_CHANGED" });
});
