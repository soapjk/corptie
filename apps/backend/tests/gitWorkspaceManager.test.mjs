import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  createGitWorkspaceSnapshot,
  inspectGitWorkspace
} from "../src/utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

test("createWorktree uses parameterized Git arguments, validates identity, and schedules a switch", async () => {
  const fixture = await createFixture("create");
  const switches = [];
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: {
      async switchWorkspace(input) {
        switches.push(input);
        return { status: "waitingForTurn", transition: { transitionId: "transition:one" } };
      }
    }
  });
  const target = join(fixture.directory, "feature worktree");

  try {
    const result = await manager.createWorktree({
      logicalSessionId: "logical:one",
      targetPath: target,
      branch: "feature/agent-created",
      baseRef: "HEAD",
      activeTurnId: "turn-active",
      switchAfterCreate: true
    });

    assert.equal(result.worktree.path, await realpath(target));
    assert.equal(result.worktree.branchName, "feature/agent-created");
    assert.equal(result.worktree.availability, "available");
    assert.equal(switches.length, 1);
    assert.equal(switches[0].targetWorktreeId, result.worktree.worktreeId);
    assert.equal(switches[0].activeTurnId, "turn-active");
    const identity = await inspectGitWorkspace(target);
    assert.equal(identity.repositoryId, result.repositoryId);
  } finally {
    await fixture.close();
  }
});

test("createWorktree rejects a stale inventory before changing Git", async () => {
  const fixture = await createFixture("stale");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  const target = join(fixture.directory, "stale target");

  try {
    await assert.rejects(
      () => manager.createWorktree({
        logicalSessionId: "logical:one",
        targetPath: target,
        branch: "feature/stale",
        inventoryVersion: "old-inventory"
      }),
      /inventory changed/
    );
    await assert.rejects(() => inspectGitWorkspace(target));
  } finally {
    await fixture.close();
  }
});

test("createWorktree rejects a branch already checked out by another worktree", async () => {
  const fixture = await createFixture("branch-conflict");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });

  try {
    await assert.rejects(
      () => manager.createWorktree({
        logicalSessionId: "logical:one",
        targetPath: join(fixture.directory, "duplicate main"),
        branch: "main"
      }),
      /already checked out/
    );
  } finally {
    await fixture.close();
  }
});

async function createFixture(label) {
  const directory = await mkdtemp(join(tmpdir(), `corptie-git-workspace-${label}-`));
  const repository = join(directory, "main repo");
  await mkdir(repository);
  await git(["init", "-b", "main"], repository);
  await git(["commit", "--allow-empty", "-m", "initial"], repository);
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const snapshot = await createGitWorkspaceSnapshot(repository);
  store.upsertGitWorkspaceSnapshot(snapshot);
  const identity = await inspectGitWorkspace(repository);
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:one",
    providerThreadId: "thread-source",
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    boundCwd: identity.canonicalPath
  });
  return {
    directory,
    repository,
    store,
    async close() {
      await store.close();
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
