import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  GitHubPushManager,
  parsePorcelainPaths,
  resolveGitHubDestination
} from "../src/runtime/gitHubPushManager.mjs";
import { GitCommitProtection } from "../src/runtime/gitCommitProtection.mjs";

const execFileAsync = promisify(execFile);

test("GitHub remote URLs are normalized and non-GitHub remotes are rejected", () => {
  assert.deepEqual(resolveGitHubDestination("git@github.com:owner/repo.git"), {
    repository: "owner/repo",
    url: "https://github.com/owner/repo"
  });
  assert.deepEqual(resolveGitHubDestination("https://github.com/owner/repo"), {
    repository: "owner/repo",
    url: "https://github.com/owner/repo"
  });
  assert.throws(() => resolveGitHubDestination("git@example.com:owner/repo.git"), /not a supported GitHub/);
});

test("porcelain paths include renamed sources and destinations", () => {
  assert.deepEqual(
    parsePorcelainPaths(" M regular.txt\0R  renamed.txt\0original.txt\0?? new.txt\0"),
    ["new.txt", "original.txt", "regular.txt", "renamed.txt"]
  );
});

test("confirmed push commits dirty changes and pushes only after explicit confirmation", async () => {
  const fixture = await createFixture();
  const manager = localPushManager();
  try {
    await writeFile(join(fixture.repository, "feature.txt"), "ready to push\n");
    const pending = await manager.status({ workingDirectory: fixture.repository });
    assert.equal(pending.available, true);
    assert.equal(pending.pending, true);
    assert.equal(pending.dirty, true);
    const prepared = await manager.prepare({
      sessionId: "codex:test",
      workingDirectory: fixture.repository
    });
    assert.equal(prepared.destinationService, "GitHub");
    assert.equal(prepared.dirty, true);
    assert.deepEqual(prepared.changedFiles, ["feature.txt"]);
    assert.equal((await gitOutput(["status", "--porcelain"], fixture.repository)).trim(), "?? feature.txt");

    const result = await manager.confirm({
      sessionId: "codex:test",
      confirmationToken: prepared.confirmationToken,
      generateCommitMessage: async () => "Add pushed feature"
    });
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal((await gitOutput(["status", "--porcelain"], fixture.repository)).trim(), "");
    assert.equal(
      (await gitOutput(["log", "-1", "--pretty=%s", "main"], fixture.remote)).trim(),
      "Add pushed feature"
    );
    const current = await manager.status({ workingDirectory: fixture.repository });
    assert.equal(current.pending, false);
    assert.equal(current.dirty, false);
    assert.equal(current.unpushedCommitCount, 0);
  } finally {
    await fixture.close();
  }
});

test("prepare refuses to open a confirmation when there is nothing to push", async () => {
  const fixture = await createFixture();
  const manager = localPushManager();
  try {
    await assert.rejects(
      () => manager.prepare({
        sessionId: "codex:test",
        workingDirectory: fixture.repository
      }),
      /no changes or commits to push/
    );
  } finally {
    await fixture.close();
  }
});

test("confirmation fails closed when the Worktree changes after review", async () => {
  const fixture = await createFixture();
  const manager = localPushManager();
  try {
    await writeFile(join(fixture.repository, "first.txt"), "first\n");
    const prepared = await manager.prepare({
      sessionId: "codex:test",
      workingDirectory: fixture.repository
    });
    await writeFile(join(fixture.repository, "second.txt"), "second\n");
    await assert.rejects(
      () => manager.confirm({
        sessionId: "codex:test",
        confirmationToken: prepared.confirmationToken,
        generateCommitMessage: async () => "Must not commit"
      }),
      /changed after confirmation/
    );
    assert.equal((await gitOutput(["status", "--porcelain"], fixture.repository)).trim().split("\n").length, 2);
  } finally {
    await fixture.close();
  }
});

test("confirmed ignore decision commits gitignore without pushing private Agent files", async () => {
  const fixture = await createFixture();
  const protection = new GitCommitProtection({
    rules: [{ path: ".corptie", kind: "directory" }]
  });
  const manager = localPushManager({ commitProtection: protection });
  try {
    await mkdir(join(fixture.repository, ".corptie"));
    await writeFile(join(fixture.repository, ".corptie", "secret.json"), "private\n");
    const prepared = await manager.prepare({
      sessionId: "codex:test",
      workingDirectory: fixture.repository
    });
    assert.equal(prepared.commitProtection.requiresDecision, true);
    assert.deepEqual(prepared.commitProtection.protectedPaths, [".corptie/secret.json"]);

    await manager.confirm({
      sessionId: "codex:test",
      confirmationToken: prepared.confirmationToken,
      privateFilesDecision: "ignore",
      generateCommitMessage: async () => "Ignore local Agent configuration"
    });
    assert.equal(
      (await gitOutput(["show", "--pretty=", "--name-only", "main"], fixture.remote)).trim(),
      ".gitignore"
    );
    assert.equal(
      (await gitOutput(["show", "main:.gitignore"], fixture.remote)).trim(),
      "# Corptie local Agent configuration\n/.corptie/"
    );
  } finally {
    await fixture.close();
  }
});

function localPushManager(options = {}) {
  return new GitHubPushManager({
    createToken: () => "confirmation-token",
    resolveDestination: () => ({
      repository: "local/test",
      url: "https://github.com/local/test"
    }),
    ...options
  });
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-github-push-"));
  const repository = join(directory, "repository");
  const remote = join(directory, "remote.git");
  await mkdir(repository);
  await git(["init", "--bare", remote], directory);
  await git(["init", "-b", "main"], repository);
  await writeFile(join(repository, "README.md"), "initial\n");
  await git(["add", "README.md"], repository);
  await git(["commit", "-m", "Initial commit"], repository);
  await git(["remote", "add", "origin", remote], repository);
  await git(["push", "--set-upstream", "origin", "main"], repository);
  return {
    directory,
    repository,
    remote,
    async close() {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function git(arguments_, cwd) {
  await execFileAsync("git", ["-C", cwd, ...arguments_], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Corptie Tests",
      GIT_AUTHOR_EMAIL: "tests@corptie.local",
      GIT_COMMITTER_NAME: "Corptie Tests",
      GIT_COMMITTER_EMAIL: "tests@corptie.local"
    }
  });
}

async function gitOutput(arguments_, cwd) {
  return execFileAsync("git", ["-C", cwd, ...arguments_], { encoding: "utf8" })
    .then((result) => result.stdout);
}
