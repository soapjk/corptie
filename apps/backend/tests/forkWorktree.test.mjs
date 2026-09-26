import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createForkWorktree } from "../src/runtime/forkWorktree.mjs";
const execFile = promisify(execFileCallback);
async function git(cwd, ...args) { return (await execFile("git", ["-C", cwd, ...args])).stdout; }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "corptie-fork-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), target = join(root, "target");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Test"); await git(source, "config", "user.email", "test@example.invalid");
  await writeFile(join(source, "file"), "base\n");
  await writeFile(join(source, "deleted"), "delete me\n");
  await writeFile(join(source, ".gitignore"), "ignored\n");
  await git(source, "add", "."); await git(source, "commit", "-m", "base");
  return { source, target };
}
test("fork preserves staged, unstaged, binary, deleted and untracked files without changing source", async t => {
  const { source, target } = await fixture(t);
  await writeFile(join(source, "file"), "staged\n"); await git(source, "add", "file");
  await writeFile(join(source, "file"), "unstaged\n");
  await rm(join(source, "deleted"));
  await writeFile(join(source, "binary"), Buffer.from([0, 255, 2, 4])); await git(source, "add", "binary");
  await mkdir(join(source, "new")); await writeFile(join(source, "new", "中文 file"), "untracked\n");
  await symlink("file", join(source, "link"));
  await writeFile(join(source, "ignored"), "not included");
  const status = await git(source, "status", "--porcelain=v1", "-z"), head = await git(source, "rev-parse", "HEAD");
  const result = await createForkWorktree({ sourcePath: source, targetPath: target, branchName: "fork/test" });
  assert.equal(await git(target, "rev-parse", "HEAD"), head);
  assert.equal(await git(target, "status", "--porcelain=v1", "-z"), status);
  assert.equal(await git(target, "diff", "--cached", "--binary"), await git(source, "diff", "--cached", "--binary"));
  assert.equal(await git(target, "diff", "--binary"), await git(source, "diff", "--binary"));
  assert.equal(await readFile(join(target, "new", "中文 file"), "utf8"), "untracked\n");
  assert.equal(await readlink(join(target, "link")), "file");
  await assert.rejects(readFile(join(target, "ignored")), { code: "ENOENT" });
  assert.equal(await git(source, "status", "--porcelain=v1", "-z"), status);
  assert.equal(await git(source, "branch", "--show-current"), "main\n");
  assert.equal(result.snapshotHash.length, 64);
});
test("fork refuses occupied targets without altering their contents", async t => {
  const { source, target } = await fixture(t);
  await mkdir(target); await writeFile(join(target, "keep"), "keep");
  await assert.rejects(createForkWorktree({ sourcePath: source, targetPath: target, branchName: "fork/test" }), { code: "FORK_PATH_OCCUPIED" });
  assert.equal(await readFile(join(target, "keep"), "utf8"), "keep");
});
