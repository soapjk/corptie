import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, readdir, symlink, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureProjectLocalState, inspectProjectLocalState, verifyProjectLocalState, rollbackProjectLocalState, writeProjectLocalFile, readProjectLocalFile } from "../src/runtime/projectLocalStateDirectory.mjs";

const exec = promisify(execFile);
async function fixture(t, git = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corptie-local-state-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (git) await exec("git", ["-C", root, "init", "-q"]);
  return root;
}
const ensure = (root, scope = "projectShared") => ensureProjectLocalState(root, { scope });

test("Git and non-Git Work roots get only the private base, without a toolset or Git changes", async t => {
  for (const isGit of [true, false]) {
    const root = await fixture(t, isGit);
    assert.equal((await inspectProjectLocalState(root, { scope: "projectShared" })).state, "missing");
    const receipt = await ensure(root);
    assert.equal(receipt.state, "ready");
    assert.equal(receipt.gitStatus, isGit ? "ignored-untracked" : "notApplicable");
    assert.deepEqual(await readdir(join(root, ".corptie")), [".gitignore"]);
    assert.equal(await readFile(join(root, ".corptie/.gitignore"), "utf8"), "*\n");
    assert.equal((await verifyProjectLocalState(receipt)).state, "ready");
    if (isGit) assert.equal((await exec("git", ["-C", root, "status", "--porcelain"])).stdout, "");
    else assert.deepEqual((await readdir(root)).sort(), [".corptie"]);
  }
});

test("existing blanket rules and files are preserved, while incomplete and negated rules are rejected", async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".corptie"));
  const ignore = join(root, ".corptie/.gitignore");
  const custom = "# user note\n*\n";
  await writeFile(ignore, custom);
  await writeFile(join(root, ".corptie/keep"), "user data");
  const receipt = await ensure(root);
  assert.equal(receipt.nativeReceipt.createdIgnore, false);
  rollbackProjectLocalState(receipt);
  assert.equal(await readFile(ignore, "utf8"), custom);
  for (const text of ["*.log\n", "*\n!important.txt\n"]) {
    await writeFile(ignore, text);
    await assert.rejects(ensure(root), { code: "LOCAL_STATE_IGNORE_CONFLICT" });
    assert.equal(await readFile(ignore, "utf8"), text);
  }
});

test("unconfigured existing content is never silently hidden by adding a new ignore file", async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".corptie"));
  await writeFile(join(root, ".corptie/keep"), "data");
  await assert.rejects(ensure(root), { code: "LOCAL_STATE_EXISTING_CONTENT" });
  assert.deepEqual(await readdir(join(root, ".corptie")), ["keep"]);
});

test("tracked state is rejected before creating or rewriting any files", async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".corptie"));
  await writeFile(join(root, ".corptie/keep"), "tracked data");
  await exec("git", ["-C", root, "add", "--force", ".corptie/keep"]);
  await assert.rejects(ensure(root), { code: "LOCAL_STATE_TRACKED" });
  assert.deepEqual(await readdir(join(root, ".corptie")), ["keep"]);
});

test("directory and ignore symlinks and non-directory targets are refused", async t => {
  const root = await fixture(t);
  const outside = await fixture(t, false);
  await writeFile(join(outside, "secret"), "do not touch");
  await symlink(outside, join(root, ".corptie"));
  await assert.rejects(ensure(root), { code: "LOCAL_STATE_PATH_UNSAFE" });
  assert.equal(await readFile(join(outside, "secret"), "utf8"), "do not touch");
  await rm(join(root, ".corptie"));
  await writeFile(join(root, ".corptie"), "not a directory");
  await assert.rejects(ensure(root), { code: "LOCAL_STATE_PATH_UNSAFE" });
  await rm(join(root, ".corptie"));
  await mkdir(join(root, ".corptie"));
  await symlink(join(outside, "secret"), join(root, ".corptie/.gitignore"));
  await assert.rejects(ensure(root), { code: "LOCAL_STATE_PATH_UNSAFE" });
});

test("sequential reuse is idempotent and concurrent prepares do not overwrite rules", async t => {
  const root = await fixture(t);
  const receipts = await Promise.all(Array.from({ length: 6 }, () => ensure(root)));
  assert.equal(receipts.filter(r => r.nativeReceipt.createdIgnore).length, 1);
  assert.equal((await ensure(root)).nativeReceipt.createdIgnore, false);
  assert.equal(new Set(receipts.map(r => r.nativeReceipt.directoryInode)).size, 1);
});

test("rollback removes only unchanged newly created empty base, retaining adopted or modified data", async t => {
  const root = await fixture(t);
  let receipt = await ensure(root);
  rollbackProjectLocalState(receipt);
  assert.deepEqual(await readdir(root), [".git"]);
  receipt = await ensure(root);
  await writeFile(join(root, ".corptie/new-user-file"), "keep");
  assert.equal(rollbackProjectLocalState(receipt).retained, true);
  assert.equal(await readFile(join(root, ".corptie/.gitignore"), "utf8"), "*\n");
  await rm(join(root, ".corptie/new-user-file"));
  await writeFile(join(root, ".corptie/.gitignore"), "# modified\n*\n");
  assert.throws(() => rollbackProjectLocalState(receipt), { code: "LOCAL_STATE_PATH_CHANGED" });
  assert.equal(await readFile(join(root, ".corptie/.gitignore"), "utf8"), "# modified\n*\n");
});

test("receipts reject replaced directories and do not delete replacement contents", async t => {
  const root = await fixture(t);
  const receipt = await ensure(root);
  await rename(join(root, ".corptie"), join(root, "old-state"));
  await mkdir(join(root, ".corptie"));
  await writeFile(join(root, ".corptie/.gitignore"), "*\n");
  await assert.rejects(verifyProjectLocalState(receipt), { code: "LOCAL_STATE_PATH_CHANGED" });
  assert.throws(() => rollbackProjectLocalState(receipt), { code: "LOCAL_STATE_PATH_CHANGED" });
  assert.equal(await readFile(join(root, ".corptie/.gitignore"), "utf8"), "*\n");
});

test("Worktree local state belongs to the selected tree, never its main checkout", async t => {
  const root = await fixture(t);
  await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
  const parent = await fixture(t, false);
  const child = join(parent, "child");
  await exec("git", ["-C", root, "worktree", "add", "-qb", "child", child]);
  const receipt = await ensure(child, "worktreeLocal");
  assert.equal(receipt.root, child);
  assert.equal((await inspectProjectLocalState(root, { scope: "projectShared" })).state, "missing");
  await writeFile(join(child, ".corptie/private-output"), "child-only");
  assert.equal((await ensure(root)).state, "ready");
  assert.deepEqual(await readdir(join(root, ".corptie")), [".gitignore"]);
});

test("bound local publication is exclusive and refuses changed directory identities and symlink ancestors", async t => {
  const root = await fixture(t);
  const receipt = await ensure(root, "worktreeLocal");
  writeProjectLocalFile(receipt, "artifacts/body.txt", Buffer.from("fixed version"));
  assert.throws(() => writeProjectLocalFile(receipt, "artifacts/body.txt", Buffer.from("replace")), /ARTIFACT_DESTINATION_EXISTS/);
  const outside = await fixture(t, false);
  await symlink(outside, join(root, ".corptie/escape"));
  assert.throws(() => writeProjectLocalFile(receipt, "escape/no.txt", Buffer.from("no")), /ARTIFACT_PATH_UNSAFE/);
  assert.deepEqual(await readdir(outside), []);
  await rename(join(root, ".corptie"), join(root, "old"));
  await ensure(root, "worktreeLocal");
  assert.throws(() => writeProjectLocalFile(receipt, "wrong.txt", Buffer.from("no")), /ARTIFACT_PATH_UNSAFE/);
  assert.deepEqual(await readdir(join(root, ".corptie")), [".gitignore"]);
});

test("read-only directories are reported before any repair writes", async t => {
  if (process.getuid?.() === 0) return t.skip("root bypasses directory permission checks");
  const root = await fixture(t);
  await ensure(root);
  const local = join(root, ".corptie");
  await chmod(local, 0o500);
  try { await assert.rejects(ensure(root), { code: "LOCAL_STATE_PERMISSION_DENIED" }); }
  finally { await chmod(local, 0o700); }
  assert.equal(await readFile(join(local, ".gitignore"), "utf8"), "*\n");
});

test("bound definition reads are bounded and never follow symlink ancestors or stale base receipts", async t => {
  const root = await fixture(t);
  const receipt = await ensure(root);
  writeProjectLocalFile(receipt, "scripts/helper", Buffer.from("private"));
  assert.equal((await readProjectLocalFile(receipt, "scripts/helper")).content.toString(), "private");
  await assert.rejects(readProjectLocalFile(receipt, "scripts/helper", { maximumBytes: 2 }), { code: "LOCAL_STATE_FILE_TOO_LARGE" });
  const outside = await fixture(t, false);
  await writeFile(join(outside, "secret"), "outside");
  await symlink(outside, join(root, ".corptie/escape"));
  await assert.rejects(readProjectLocalFile(receipt, "escape/secret"), /LOCAL_STATE_FILE_UNSAFE/);
  await rename(join(root, ".corptie"), join(root, "old-state"));
  await ensure(root);
  await assert.rejects(readProjectLocalFile(receipt, "scripts/helper"), /LOCAL_STATE_PATH_CHANGED/);
});
