import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  GitHubPushManager,
  parseNameStatusChanges,
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

test("name-status changes are separated into added, modified, and deleted files", () => {
  assert.deepEqual(
    parseNameStatusChanges("A\0added.txt\0M\0modified.txt\0D\0deleted.txt\0T\0type-changed.txt\0"),
    {
      added: ["added.txt"],
      modified: ["modified.txt", "type-changed.txt"],
      deleted: ["deleted.txt"]
    }
  );
});

test("push preparation clearly classifies the final file changes", async () => {
  const fixture = await createFixture();
  const manager = localPushManager();
  try {
    await writeFile(join(fixture.repository, "remove-me.txt"), "remove me\n");
    await git(["add", "remove-me.txt"], fixture.repository);
    await git(["commit", "-m", "Add removable file"], fixture.repository);
    await git(["push"], fixture.repository);

    await writeFile(join(fixture.repository, "README.md"), "updated\n");
    await writeFile(join(fixture.repository, "new-file.txt"), "new\n");
    await rm(join(fixture.repository, "remove-me.txt"));

    const prepared = await manager.prepare({
      sessionId: "codex:test",
      workingDirectory: fixture.repository
    });
    assert.deepEqual(prepared.addedFiles, ["new-file.txt"]);
    assert.deepEqual(prepared.modifiedFiles, ["README.md"]);
    assert.deepEqual(prepared.deletedFiles, ["remove-me.txt"]);
    assert.deepEqual(prepared.filesToPush, ["README.md", "new-file.txt", "remove-me.txt"]);
  } finally {
    await fixture.close();
  }
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

test("Agent-generated commit message can be reviewed and edited before confirmation", async () => {
  const fixture = await createFixture();
  const manager = localPushManager();
  try {
    await writeFile(join(fixture.repository, "editable.txt"), "review me\n");
    const prepared = await manager.prepare({
      sessionId: "codex:test",
      workingDirectory: fixture.repository
    });
    const suggestion = await manager.generateCommitMessage({
      sessionId: "codex:test",
      confirmationToken: prepared.confirmationToken,
      generateCommitMessage: async () => "Add editable file"
    });
    assert.equal(suggestion, "Add editable file");

    const result = await manager.confirm({
      sessionId: "codex:test",
      confirmationToken: prepared.confirmationToken,
      commitMessage: "Refine editable file handling",
      generateCommitMessage: async () => assert.fail("confirmation must use the reviewed message")
    });

    assert.equal(result.commitMessage, "Refine editable file handling");
    assert.equal(
      (await gitOutput(["log", "-1", "--pretty=%s", "main"], fixture.remote)).trim(),
      "Refine editable file handling"
    );
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

test("branch push sends only existing commits and establishes the upstream without force", async () => {
  const fixture = await createFixture();
  const gitCalls = [];
  const manager = localPushManager({
    execFile: async (file, arguments_, options) => {
      gitCalls.push([file, [...arguments_]]);
      return execFileAsync(file, arguments_, options);
    }
  });
  try {
    await git(["switch", "-c", "feature/push-button"], fixture.repository);
    await writeFile(join(fixture.repository, "feature.txt"), "committed content\n");
    await git(["add", "feature.txt"], fixture.repository);
    await git(["commit", "-m", "Add push button fixture"], fixture.repository);
    await writeFile(join(fixture.repository, "uncommitted.txt"), "must remain local\n");

    const pending = await manager.branchStatus({ workingDirectory: fixture.repository });
    assert.equal(pending.available, true);
    assert.equal(pending.pending, true);
    assert.equal(pending.dirty, true);
    assert.equal(pending.branch, "feature/push-button");

    const result = await manager.pushBranch({ workingDirectory: fixture.repository });
    assert.equal(result.pushed, true);
    assert.equal(result.committed, false);
    assert.equal(
      (await gitOutput(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], fixture.repository)).trim(),
      "origin/feature/push-button"
    );
    assert.equal(
      (await gitOutput(["log", "-1", "--pretty=%s", "feature/push-button"], fixture.remote)).trim(),
      "Add push button fixture"
    );
    assert.equal((await gitOutput(["status", "--porcelain"], fixture.repository)).trim(), "?? uncommitted.txt");
    const pushCall = gitCalls.find(([, arguments_]) => arguments_[2] === "push");
    assert.deepEqual(pushCall?.[1].slice(2), [
      "push", "--set-upstream", "origin", "HEAD:refs/heads/feature/push-button"
    ]);
    assert.equal(pushCall?.[1].some((argument) => argument.includes("force")), false);

    const current = await manager.branchStatus({ workingDirectory: fixture.repository });
    assert.equal(current.pending, false);
  } finally {
    await fixture.close();
  }
});

test("branch push status explains a missing GitHub remote", async () => {
  const fixture = await createFixture();
  const manager = localPushManager();
  try {
    await git(["remote", "remove", "origin"], fixture.repository);
    const status = await manager.branchStatus({ workingDirectory: fixture.repository });
    assert.equal(status.available, false);
    assert.equal(status.pending, false);
    assert.match(status.error, /No supported GitHub remote is configured/);
  } finally {
    await fixture.close();
  }
});

test("branch push uses the unique configured GitHub remote when origin is absent", async () => {
  const fixture = await createFixture();
  const manager = localPushManager();
  try {
    await git(["remote", "rename", "origin", "github"], fixture.repository);
    await git(["switch", "-c", "feature/custom-remote"], fixture.repository);
    await writeFile(join(fixture.repository, "custom.txt"), "custom remote\n");
    await git(["add", "custom.txt"], fixture.repository);
    await git(["commit", "-m", "Push through custom remote"], fixture.repository);

    await manager.pushBranch({ workingDirectory: fixture.repository });

    assert.equal(
      (await gitOutput(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], fixture.repository)).trim(),
      "github/feature/custom-remote"
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
      "# Corptie local Agent configuration\n/.corptie"
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
