import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { safeTurnFileChanges, turnDiffFor, writeTurnPatch, prepareExternalDiff, createDiffToolLauncher } from "../src/application/turnDiffReview.mjs";

test("turn changes retain normalized paths and reject directory escape", () => {
  const items = [{ type: "fileChange", fileChanges: [
    { path: "/workspace/src/a.mjs", kind: { type: "add" }, diff: "one\ntwo\n" },
    { path: "src\\b.mjs", kind: "delete", diff: "old\n" }
  ] }];
  const changes = safeTurnFileChanges(items, "/workspace");
  assert.deepEqual(changes.map(({ path, kind }) => ({ path, kind })), [
    { path: "src/a.mjs", kind: "add" }, { path: "src/b.mjs", kind: "delete" }
  ]);
  const diff = turnDiffFor(items, changes);
  assert.match(diff, /@@ -0,0 \+1,2 @@\n\+one\n\+two/);
  assert.match(diff, /@@ -1,1 \+0,0 @@\n-old/);
  for (const path of ["../outside", "/workspace-other/file", "/workspace", ".", ""]) {
    assert.throws(() => safeTurnFileChanges([{ type: "fileChange", fileChanges: [{ path }] }], "/workspace"), /Unsafe/);
  }
  assert.throws(() => safeTurnFileChanges([], "/workspace"), /no recorded file changes/);
  assert.equal(turnDiffFor([{ turnDiff: "first" }, { turnDiff: "last" }, { turnDiff: " " }], changes), "last");
});

for (const currentContent of ["before\n", "after\n"]) {
  test(`review reconstructs both sides from ${currentContent.trim()} working copy`, async (t) => {
    const cwd = await mkdtemp(join(os.tmpdir(), "corptie-diff-test-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, "sample.txt"), currentContent);
    const changes = [{ path: "sample.txt", kind: "update", diff: "@@ -1 +1 @@\n-before\n+after\n" }];
    const diff = turnDiffFor([], changes);
    const review = await prepareExternalDiff(cwd, "session", "turn", changes, diff);
    t.after(() => rm(review.root, { recursive: true, force: true }));
    assert.equal(await readFile(join(review.beforeDir, "sample.txt"), "utf8"), "before\n");
    assert.equal(await readFile(join(review.afterDir, "sample.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), currentContent);
    assert.equal(await readFile(review.patchPath, "utf8"), diff);
  });
}

test("patch export rejects empty diffs and keeps session identifiers in the temporary directory", async (t) => {
  await assert.rejects(writeTurnPatch("session", "turn", "  "), /usable diff/);
  const patch = await writeTurnPatch("session/child", "turn/child", "patch\n");
  t.after(() => rm(patch.root, { recursive: true, force: true }));
  assert.equal(patch.patchPath, join(patch.root, "session_child-turn_child.diff"));
  assert.equal(await readFile(patch.patchPath, "utf8"), "patch\n");
});

test("diff tool selection and launch arguments are preserved without opening applications", async () => {
  const launches = [];
  const placeholders = [];
  let installed = true;
  const launch = createDiffToolLauncher({
    executableExists: () => installed,
    applicationExists: () => installed,
    launch: (...args) => launches.push(args),
    ensurePlaceholder: async (path) => placeholders.push(path)
  });
  const review = { beforeDir: "/review/Before", afterDir: "/review/After" };
  const changes = [{ path: "a.txt" }];
  assert.equal(await launch("automatic", review, changes), "vscode");
  assert.deepEqual(placeholders, ["/review/Before/a.txt", "/review/After/a.txt"]);
  assert.deepEqual(launches.at(-1)[1], ["--reuse-window", "--diff", ...placeholders]);
  installed = false;
  assert.equal(await launch("automatic", review, changes), "filemerge");
  assert.deepEqual(launches.at(-1), ["/usr/bin/opendiff", [review.beforeDir, review.afterDir]]);
  assert.equal(await launch("git-difftool", review, changes), "git-difftool");
  assert.deepEqual(launches.at(-1), ["git", ["difftool", "--no-index", "--dir-diff", "--no-prompt", review.beforeDir, review.afterDir]]);
  await assert.rejects(launch("vscode", review, changes), /not installed/);
  await assert.rejects(launch("kaleidoscope", review, changes), /not installed/);
  await assert.rejects(launch("unknown", review, changes), /Unsupported/);
});
