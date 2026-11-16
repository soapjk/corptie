import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupArtifactCommitHook } from "../src/runtime/artifactCommitHook.mjs";
import { assertManagedArtifactGitOperation } from "../src/runtime/artifactManagedGitGate.mjs";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corptie-hook-retirement-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Tests"); git("config", "user.email", "tests@example.invalid"); git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "initial");
  return { root, git };
}
const wrapper = original => `#!/bin/sh\n# Corptie managed Artifact commit gate v2\n# original-hook: ${JSON.stringify(original)}\n${original ? `if [ -x '${original}' ]; then '${original}' "$@" || exit $?; fi\n` : ""}exec '/missing/node' '/missing/artifactCommitHookCli.mjs' '/missing/db'\n`;

test("retirement restores proven custom hooks across shared worktrees and is idempotent", async t => {
  const { root, git } = await fixture(t);
  const original = join(root, "user-hooks"), managed = join(root, ".git/corptie-managed/hooks");
  await mkdir(original); await mkdir(managed, { recursive: true });
  await writeFile(join(original, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(managed, "pre-commit"), wrapper(join(original, "pre-commit")), { mode: 0o700 });
  git("config", "core.hooksPath", managed);
  const linked = join(root, "linked"); git("worktree", "add", "-b", "linked", linked);
  await Promise.all([cleanupArtifactCommitHook(root), cleanupArtifactCommitHook(linked)]);
  assert.equal(git("config", "--get", "core.hooksPath"), original);
  await cleanupArtifactCommitHook(root);
  assert.equal(await readFile(join(original, "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
  git("commit", "--allow-empty", "-m", "terminal commit without DB");
});

test("retirement removes only owned wrappers, preserves unknown custom config and user files", async t => {
  const { root, git } = await fixture(t);
  const hooks = join(root, "custom"); await mkdir(hooks);
  await writeFile(join(hooks, "pre-commit"), wrapper(""), { mode: 0o700 });
  const user = "#!/bin/sh\n# user pre-push\nexit 0\n";
  await writeFile(join(hooks, "pre-push"), user);
  git("config", "core.hooksPath", "custom");
  await cleanupArtifactCommitHook(root);
  assert.equal(git("config", "--get", "core.hooksPath"), "custom");
  assert.equal(await readFile(join(hooks, "pre-push"), "utf8"), user);
  git("commit", "--allow-empty", "-m", "terminal");
});

test("empty managed install is unset and never reinstalled; user replacement is retained", async t => {
  const { root, git } = await fixture(t);
  const hooks = join(root, ".git/corptie-managed/hooks"); await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, "pre-commit"), wrapper(""), { mode: 0o700 });
  await writeFile(join(hooks, "pre-commit.790.uuid.tmp"), "");
  git("config", "core.hooksPath", hooks);
  await cleanupArtifactCommitHook(root); await cleanupArtifactCommitHook(root);
  assert.throws(() => git("config", "--local", "--get", "core.hooksPath"));
  await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  git("config", "core.hooksPath", hooks); await cleanupArtifactCommitHook(root);
  assert.equal(git("config", "--get", "core.hooksPath"), hooks);
  assert.equal(await readFile(join(hooks, "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
});

test("managed commits query evidence lazily, reject documents, while direct Git remains independent", async t => {
  const { root, git } = await fixture(t);
  const gate = (cwd, args) => assertManagedArtifactGitOperation(cwd, args, { verifyPromotion: () => { throw new Error("DB unavailable"); } });
  const manager = new GitWorkspaceManager({ store: {}, ensureCommitGate: gate });
  await writeFile(join(root, "code.kt"), "fun main() {}\n"); git("add", "code.kt");
  await manager.runGit(root, ["commit", "-m", "code"]);
  await writeFile(join(root, "new.md"), "document\n"); git("add", "new.md");
  await assert.rejects(manager.runGit(root, ["commit", "-m", "document"]), /DB unavailable/);
  git("commit", "-m", "direct Git independent");
});

test("managed merge checks incoming tree including fast-forward and does not mutate index on rejection", async t => {
  const { root, git } = await fixture(t);
  git("checkout", "-b", "source"); await writeFile(join(root, "new.pdf"), "pdf"); git("add", "new.pdf"); git("commit", "-m", "external document"); git("checkout", "main");
  const head = git("rev-parse", "HEAD"), index = git("ls-files", "--stage");
  for (const flags of [["--ff-only"], ["--no-ff", "--no-edit"]]) {
    await assert.rejects(assertManagedArtifactGitOperation(root, ["merge", ...flags, "source"]), { code: "GIT_ARTIFACT_POLICY_REJECTED" });
    assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("ls-files", "--stage"), index);
  }
  await assertManagedArtifactGitOperation(root, ["merge", "--ff-only", "source"], { verifyPromotion: () => true });
  git("merge", "--ff-only", "source");
});

test("cleanup preserves user additions to a generated wrapper", async t => {
  const { root, git } = await fixture(t);
  const hooks = join(root, "user-hooks"); await mkdir(hooks);
  const content = wrapper("") + "# user addition\necho custom\n";
  await writeFile(join(hooks, "pre-commit"), content); git("config", "core.hooksPath", hooks);
  await cleanupArtifactCommitHook(root);
  assert.equal(await readFile(join(hooks, "pre-commit"), "utf8"), content);
});
