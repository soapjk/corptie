import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { inspectGitWorkspace } from "../src/utils/gitWorktreeInventory.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "corptie-rollback-preview-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", ["-C", path, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Rollback Test");
  await git("config", "user.email", "rollback@example.invalid");
  const commit = async (file, text) => {
    await writeFile(join(path, file), text);
    await git("add", file); await git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  const before = await commit("shared.txt", "base\n");
  await git("switch", "-c", "feature-a");
  const sourceA = await commit("shared.txt", "main change\n");
  await git("switch", "-c", "feature-b", before);
  const sourceB = await commit("shared.txt", "child change\n");
  await git("switch", "main");
  await git("merge", "--no-ff", "feature-a", "-m", "first integration");
  const resultA = await git("rev-parse", "HEAD");
  await assert.rejects(git("merge", "--no-ff", "feature-b", "-m", "second integration"));
  const identity = await inspectGitWorkspace(path);
  const manager = new GitWorkspaceManager({ store: {} });
  const target = { worktreeId: identity.worktreeId, path, branchName: "main", baselineHead: before,
    writes: [{ sourceHead: sourceA, resultHead: resultA, status: "completed" },
      { sourceHead: sourceB, resultHead: null, status: "conflict" }] };
  const inspect = () => manager.inspectIntegrationRollbackTarget({ repositoryId: identity.repositoryId, target });
  return { path, git, commit, inspect, resultA, target, identity, manager };
}

test("rollback inspection preserves the conflicted index and working files", async t => {
  const f = await fixture(t);
  const before = await f.git("ls-files", "--stage");
  const result = await f.inspect();
  assert.equal(result.mode, "restore_baseline");
  assert.equal(result.operationOwned, true);
  assert.equal(result.requiresPreservation, true);
  assert.deepEqual(result.ownedCommits, [f.resultA]);
  assert.equal(await f.git("ls-files", "--stage"), before);
  assert.equal(await f.git("rev-parse", "HEAD"), f.resultA);
  assert.ok(await f.git("rev-parse", "MERGE_HEAD"));
});

test("a completed manual resolution and later external commits produce distinct rollback plans", async t => {
  const f = await fixture(t);
  const resolution = await f.commit("shared.txt", "resolved\n");
  let result = await f.inspect();
  assert.equal(result.mode, "restore_baseline");
  assert.deepEqual(result.ownedCommits, [f.resultA, resolution]);
  const external = await f.commit("external.txt", "keep this\n");
  result = await f.inspect();
  assert.equal(result.mode, "review_additional_history");
  assert.deepEqual(result.additionalCommits, [external]);
  assert.equal(await f.git("rev-parse", "HEAD"), external);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("published integration history requires impact review and changed identity has an actionable failure", async t => {
  const f = await fixture(t);
  const resolution = await f.commit("shared.txt", "resolved\n");
  await f.git("update-ref", "refs/remotes/origin/main", resolution);
  const result = await f.inspect();
  assert.equal(result.mode, "review_additional_history");
  assert.equal(result.published, true);
  await assert.rejects(f.manager.inspectIntegrationRollbackTarget({ repositoryId: "wrong-repository", target: f.target }),
    { code: "WORKTREE_IDENTITY_CHANGED" });
  assert.equal(await f.git("rev-parse", "HEAD"), resolution);
});

test("confirmed reset restores the round's baseline and retains both source branches", async t => {
  const f = await fixture(t);
  const sourceA = await f.git("rev-parse", "feature-a");
  const sourceB = await f.git("rev-parse", "feature-b");
  const preview = await f.inspect();
  await assert.rejects(f.manager.rollbackIntegrationTarget({ repositoryId: f.identity.repositoryId, target: preview }),
    { code: "ROLLBACK_EDITS_REQUIRE_CONFIRMATION" });
  await f.manager.rollbackIntegrationTarget({ repositoryId: f.identity.repositoryId, target: preview, discardChanges: true });
  assert.equal(await f.git("rev-parse", "HEAD"), f.target.baselineHead);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await f.git("rev-parse", "feature-a"), sourceA);
  assert.equal(await f.git("rev-parse", "feature-b"), sourceB);
  assert.equal((await f.manager.rollbackIntegrationTarget({ repositoryId: f.identity.repositoryId, target: preview })).mainHead,
    f.target.baselineHead);
});

test("a completed manual resolution resets normally instead of failing MAIN_HEAD_CHANGED", async t => {
  const f = await fixture(t);
  await f.commit("shared.txt", "resolved\n");
  const preview = await f.inspect();
  await f.manager.rollbackIntegrationTarget({ repositoryId: f.identity.repositoryId, target: preview });
  assert.equal(await f.git("rev-parse", "HEAD"), f.target.baselineHead);
});

test("changing files after the preview requires a new review before any reset", async t => {
  const f = await fixture(t);
  await f.commit("shared.txt", "resolved\n");
  const preview = await f.inspect();
  await writeFile(join(f.path, "shared.txt"), "keep new edits\n");
  const head = await f.git("rev-parse", "HEAD");
  await assert.rejects(f.manager.rollbackIntegrationTarget({ repositoryId: f.identity.repositoryId, target: preview, discardChanges: true }),
    { code: "ROLLBACK_REVIEW_REQUIRED" });
  assert.equal(await f.git("rev-parse", "HEAD"), head);
});

test("extra local history is listed and only reset when its impact is explicitly confirmed", async t => {
  const f = await fixture(t);
  await f.commit("shared.txt", "resolved\n");
  const external = await f.commit("external.txt", "extra commit\n");
  const preview = await f.inspect();
  assert.deepEqual(preview.additionalCommits, [external]);
  await assert.rejects(f.manager.rollbackIntegrationTarget({ repositoryId: f.identity.repositoryId, target: preview }),
    { code: "ROLLBACK_ADDITIONAL_COMMITS" });
  assert.equal(await f.git("rev-parse", "HEAD"), external);
  await f.manager.rollbackIntegrationTarget({ repositoryId: f.identity.repositoryId, target: preview, includeAdditionalCommits: true });
  assert.equal(await f.git("rev-parse", "HEAD"), f.target.baselineHead);
});
