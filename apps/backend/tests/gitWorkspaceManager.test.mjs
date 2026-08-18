import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  await mkdir(join(fixture.repository, ".corptie"));
  await writeFile(join(fixture.repository, ".corptie", "private.json"), "{}\n");
  await mkdir(join(fixture.repository, ".agents", "skills"), { recursive: true });
  await writeFile(join(fixture.repository, ".agents", "skills", "local.md"), "private skill\n");
  await writeFile(join(fixture.repository, "AGENTS.md"), "# Tracked instructions\n");
  await git(["add", "AGENTS.md"], fixture.repository);
  await git(["commit", "-m", "add tracked instructions"], fixture.repository);
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
    assert.deepEqual(result.sharedAgentConfiguration.linked.sort(), [".agents", ".corptie"]);
    assert.equal(
      await readlink(join(target, ".corptie")),
      join(await realpath(fixture.repository), ".corptie")
    );
    assert.equal(
      await readlink(join(target, ".agents")),
      join(await realpath(fixture.repository), ".agents")
    );
    assert.equal((await lstat(join(target, "AGENTS.md"))).isSymbolicLink(), false);
    assert.deepEqual(
      (await gitOutput(["status", "--short"], target)).trim().split("\n").sort(),
      ["?? .agents", "?? .corptie"]
    );
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

test("a failed post-create transition preserves the worktree and retry does not duplicate it", async () => {
  const fixture = await createFixture("transition-retry");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: {
      async switchWorkspace() {
        throw new Error("simulated transition failure");
      }
    }
  });
  const target = join(fixture.directory, "preserved worktree");

  try {
    await assert.rejects(
      () => manager.createWorktree({
        logicalSessionId: "logical:one",
        targetPath: target,
        branch: "feature/preserved"
      }),
      /simulated transition failure/
    );
    const identity = await inspectGitWorkspace(target);
    assert.equal(
      fixture.store.getGitWorktree(identity.worktreeId)?.branchName,
      "feature/preserved"
    );

    await assert.rejects(
      () => manager.createWorktree({
        logicalSessionId: "logical:one",
        targetPath: target,
        branch: "feature/preserved"
      }),
      /already exists/
    );
  } finally {
    await fixture.close();
  }
});

test("session deletion plan commits a dirty bound worktree and merges it into main", async () => {
  const fixture = await createFixture("delete-merge", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.activeWorktree, "session-change.txt"), "made by the session\n");

  try {
    const plan = await manager.sessionDeletionPlan("logical:one");
    assert.equal(plan.requiresWorktreeMerge, true);
    assert.equal(plan.sourceBranch, "feature/session-worktree");
    assert.equal(plan.mainBranch, "main");
    assert.equal(plan.hasUncommittedChanges, true);

    const result = await manager.mergeSessionWorktreeIntoMain({
      logicalSessionId: "logical:one",
      commitMessage: "Save session worktree changes"
    });

    assert.equal(result.merged, true);
    assert.equal(result.committed, true);
    assert.equal(result.commitMessage, "Save session worktree changes");
    assert.equal(
      (await gitOutput(["log", "-1", "--pretty=%s"], fixture.activeWorktree)).trim(),
      "Save session worktree changes"
    );
    assert.equal(await readFile(join(fixture.repository, "session-change.txt"), "utf8"), "made by the session\n");
    assert.equal((await gitOutput(["status", "--porcelain"], fixture.repository)).trim(), "");
  } finally {
    await fixture.close();
  }
});

test("session deletion merge refuses to modify a dirty main worktree", async () => {
  const fixture = await createFixture("dirty-main", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.repository, "main-change.txt"), "keep me\n");
  await writeFile(join(fixture.activeWorktree, "source-change.txt"), "source\n");

  try {
    await assert.rejects(
      () => manager.mergeSessionWorktreeIntoMain({
        logicalSessionId: "logical:one",
        commitMessage: "Should not be used"
      }),
      /main worktree has uncommitted changes/
    );
    assert.match(await gitOutput(["status", "--porcelain"], fixture.activeWorktree), /source-change\.txt/);
  } finally {
    await fixture.close();
  }
});

test("uncommitted changes in the main worktree can be committed explicitly", async () => {
  const fixture = await createFixture("commit-main", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.repository, "main-change.txt"), "commit from manager\n");
  try {
    const project = await manager.projectStatus("logical:one");
    const main = project.worktrees.find((worktree) => worktree.isMain);
    const result = await manager.commitWorktreeChanges({
      logicalSessionId: "logical:one",
      sourceWorktreeId: main.worktreeId,
      commitMessage: "Commit main worktree changes"
    });
    assert.equal(result.committed, true);
    assert.equal(result.commitMessage, "Commit main worktree changes");
    assert.equal((await gitOutput(["status", "--porcelain"], fixture.repository)).trim(), "");
    assert.equal(
      (await gitOutput(["log", "-1", "--pretty=%s"], fixture.repository)).trim(),
      "Commit main worktree changes"
    );
  } finally {
    await fixture.close();
  }
});

test("project status distinguishes working, pending, and synchronized worktrees", async () => {
  const fixture = await createFixture("project-status", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    let project = await manager.projectStatus("logical:one");
    let feature = project.worktrees.find((worktree) => !worktree.isMain);
    assert.equal(project.pendingWorktreeCount, 0);
    assert.equal(feature.state, "synced");
    assert.equal(feature.synchronizedWithMain, true);

    await writeFile(join(fixture.activeWorktree, "feature.txt"), "working\n");
    project = await manager.projectStatus("logical:one");
    feature = project.worktrees.find((worktree) => !worktree.isMain);
    assert.equal(project.pendingWorktreeCount, 1);
    assert.equal(feature.state, "working");
    assert.equal(feature.dirty, true);
    assert.equal(feature.synchronizedWithMain, false);

    await git(["add", "feature.txt"], fixture.activeWorktree);
    await git(["commit", "-m", "feature work"], fixture.activeWorktree);
    project = await manager.projectStatus("logical:one");
    feature = project.worktrees.find((worktree) => !worktree.isMain);
    assert.equal(feature.state, "readyToMerge");
    assert.equal(feature.aheadOfMain, 1);
    assert.equal(feature.mergedIntoMain, false);
    assert.equal(feature.synchronizedWithMain, false);
  } finally {
    await fixture.close();
  }
});

test("project status can be inspected by repository path without an Agent Session", async () => {
  const fixture = await createFixture("project-status-without-session", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const project = await manager.projectStatusForPath(fixture.repository, fixture.repositoryId);
    assert.equal(project.repositoryId, fixture.repositoryId);
    assert.equal(project.mainPath, await realpath(fixture.repository));
    assert.equal(project.worktrees.length, 2);
  } finally {
    await fixture.close();
  }
});

test("project status excludes stale logical routes whose Sessions were deleted", async () => {
  const fixture = await createFixture("project-status-live-sessions");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const repository = fixture.store.getLogicalSession("logical:one");
    const live = fixture.store.createLogicalSessionRoute({
      logicalSessionId: "logical:live",
      legacySessionId: "codex:live-thread",
      providerThreadId: "live-thread",
      repositoryId: repository.repositoryId,
      worktreeId: repository.activeWorkspaceId,
      boundCwd: fixture.repository,
      title: "Live session"
    });
    fixture.store.upsertSession({
      id: live.legacySessionId,
      title: "Live session",
      agent: "Codex",
      provider: "codex-app-server",
      cwd: fixture.repository,
      status: "complete"
    });
    fixture.store.createLogicalSessionRoute({
      logicalSessionId: "logical:deleted",
      legacySessionId: "codex:deleted-thread",
      providerThreadId: "deleted-thread",
      repositoryId: repository.repositoryId,
      worktreeId: repository.activeWorkspaceId,
      boundCwd: fixture.repository,
      title: "Deleted session"
    });

    const project = await manager.projectStatus("logical:one");
    const main = project.worktrees.find((worktree) => worktree.isMain);
    assert.deepEqual(main.sessions.map((session) => session.sessionId), ["codex:live-thread"]);
  } finally {
    await fixture.close();
  }
});

test("the primary worktree branch is not required to be named main", async () => {
  const fixture = await createFixture("custom-primary-branch", {
    activeFeatureWorktree: true,
    mainBranch: "dev_nau"
  });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const project = await manager.projectStatusForPath(fixture.repository, fixture.repositoryId);
    assert.equal(project.mainBranch, "dev_nau");
    assert.equal(project.worktrees.length, 2);

    await writeFile(join(fixture.activeWorktree, "custom-primary.txt"), "custom primary\n");
    const merged = await manager.mergeWorktreeIntoMain({
      logicalSessionId: "logical:one",
      commitMessage: "Merge into custom primary branch"
    });
    assert.equal(merged.merged, true);
    assert.equal(await readFile(join(fixture.repository, "custom-primary.txt"), "utf8"), "custom primary\n");
  } finally {
    await fixture.close();
  }
});

test("project workspace changes can be committed without a logical Session id", async () => {
  const fixture = await createFixture("project-commit-without-session", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.activeWorktree, "project-api.txt"), "project owned\n");
  try {
    const status = await manager.projectStatusForPath(fixture.repository, fixture.repositoryId);
    const feature = status.worktrees.find((worktree) => !worktree.isMain);
    const commit = await manager.commitWorktreeChangesForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      sourceWorktreeId: feature.worktreeId,
      commitMessage: "Commit through Project API"
    });
    assert.equal(commit.committed, true);
    assert.equal(commit.sourceWorktreeId, feature.worktreeId);
    assert.equal(
      (await gitOutput(["log", "-1", "--pretty=%s"], fixture.activeWorktree)).trim(),
      "Commit through Project API"
    );
  } finally {
    await fixture.close();
  }
});

test("project merge preserves conflict diagnostics and aborts the failed merge", async () => {
  const fixture = await createFixture("project-conflict", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.repository, "shared.txt"), "main\n");
  await git(["add", "shared.txt"], fixture.repository);
  await git(["commit", "-m", "Main version"], fixture.repository);
  await writeFile(join(fixture.activeWorktree, "shared.txt"), "feature\n");
  await git(["add", "shared.txt"], fixture.activeWorktree);
  await git(["commit", "-m", "Feature version"], fixture.activeWorktree);

  try {
    const status = await manager.projectStatusForPath(fixture.repository, fixture.repositoryId);
    const feature = status.worktrees.find((worktree) => !worktree.isMain);
    await assert.rejects(
      () => manager.mergeWorktreeIntoMainForProject({
        repositoryId: fixture.repositoryId,
        workingDirectory: fixture.repository,
        sourceWorktreeId: feature.worktreeId,
        synchronizeSource: false
      }),
      (error) => {
        assert.match(`${String(error.stdout)}\n${String(error.stderr)}`, /CONFLICT .*shared\.txt/);
        return true;
      }
    );
    assert.equal((await gitOutput(["status", "--porcelain=v1"], fixture.repository)).trim(), "");
    await assert.rejects(() => gitOutput(["rev-parse", "-q", "--verify", "MERGE_HEAD"], fixture.repository));
  } finally {
    await fixture.close();
  }
});

test("creates a dedicated Integration Worktree from the current main revision", async () => {
  const fixture = await createFixture("integration-worktree");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const mainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();
    const created = await manager.createIntegrationWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      runId: "integration:run-one"
    });
    assert.equal(created.branchName, "integration/run-one");
    assert.equal(created.headOid, mainHead);
    assert.equal((await gitOutput(["rev-parse", "HEAD"], created.path)).trim(), mainHead);
    const status = await manager.projectStatusForPath(fixture.repository, fixture.repositoryId);
    assert.equal(status.worktrees.some((worktree) => worktree.worktreeId === created.worktreeId), true);
  } finally {
    await fixture.close();
  }
});

test("stage merge retains and synchronizes the source worktree", async () => {
  const fixture = await createFixture("stage-merge", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.activeWorktree, "stage.txt"), "stage\n");
  try {
    const result = await manager.mergeWorktreeIntoMain({
      logicalSessionId: "logical:one",
      commitMessage: "Stage worktree progress",
      synchronizeSource: true
    });
    assert.equal(result.merged, true);
    assert.equal(result.committed, true);
    assert.equal(result.sourceSynchronized, true);
    assert.equal(await readFile(join(fixture.repository, "stage.txt"), "utf8"), "stage\n");
    assert.equal(
      (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim(),
      (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim()
    );
    const project = await manager.projectStatus("logical:one");
    const feature = project.worktrees.find((worktree) => !worktree.isMain);
    assert.equal(feature.state, "synced");
    assert.equal(feature.synchronizedWithMain, true);
    assert.equal(project.pendingWorktreeCount, 0);
  } finally {
    await fixture.close();
  }
});

test("merge blocks a committed local Agent link that would loop in the main Worktree", async () => {
  const fixture = await createFixture("shared-link-merge", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  const mainToolsetPath = join(await realpath(fixture.repository), ".corptie");
  await symlink(mainToolsetPath, join(fixture.activeWorktree, ".corptie"));
  await git(["add", "--force", ".corptie"], fixture.activeWorktree);
  await git(["commit", "-m", "Accidentally track local toolset link"], fixture.activeWorktree);
  const mainHeadBefore = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();

  try {
    await assert.rejects(
      () => manager.mergeWorktreeIntoMain({ logicalSessionId: "logical:one" }),
      (error) => error?.code === "GIT_SHARED_AGENT_LINK_MERGE_BLOCKED"
    );
    assert.equal((await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim(), mainHeadBefore);
    await assert.rejects(() => lstat(mainToolsetPath), /ENOENT/);
  } finally {
    await fixture.close();
  }
});

test("a merged worktree can be synchronized with main as a separate operation", async () => {
  const fixture = await createFixture("separate-sync", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.activeWorktree, "separate.txt"), "separate\n");
  try {
    await manager.mergeWorktreeIntoMain({
      logicalSessionId: "logical:one",
      commitMessage: "Merge before separate sync",
      synchronizeSource: false
    });
    let project = await manager.projectStatus("logical:one");
    let feature = project.worktrees.find((worktree) => !worktree.isMain);
    assert.equal(feature.mergedIntoMain, true);
    assert.equal(feature.synchronizedWithMain, false);

    const result = await manager.synchronizeWorktreeWithMain({
      logicalSessionId: "logical:one",
      sourceWorktreeId: feature.worktreeId
    });
    assert.equal(result.synchronized, true);
    project = await manager.projectStatus("logical:one");
    feature = project.worktrees.find((worktree) => !worktree.isMain);
    assert.equal(feature.synchronizedWithMain, true);
  } finally {
    await fixture.close();
  }
});

test("completed merge removes the worktree and its merged branch", async () => {
  const fixture = await createFixture("complete", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.activeWorktree, "complete.txt"), "complete\n");
  try {
    const merge = await manager.mergeWorktreeIntoMain({
      logicalSessionId: "logical:one",
      commitMessage: "Complete worktree"
    });
    const removed = await manager.removeMergedWorktree({
      logicalSessionId: "logical:one",
      sourceWorktreeId: merge.sourceWorktreeId,
      ignoreLogicalSessionIds: ["logical:one"],
      deleteBranch: true
    });
    assert.equal(removed.removed, true);
    assert.equal(removed.branchDeleted, true);
    await assert.rejects(() => inspectGitWorkspace(fixture.activeWorktree));
    await assert.rejects(
      () => gitOutput(["rev-parse", "--verify", "feature/session-worktree"], fixture.repository)
    );
  } finally {
    await fixture.close();
  }
});

test("unmerged worktree deletion requires irreversible confirmation and the exact branch name", async () => {
  const fixture = await createFixture("force-delete", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    await writeFile(join(fixture.activeWorktree, "first.txt"), "first\n");
    await git(["add", "first.txt"], fixture.activeWorktree);
    await git(["commit", "-m", "First unmerged change"], fixture.activeWorktree);
    await writeFile(join(fixture.activeWorktree, "second.txt"), "second\n");
    await git(["add", "second.txt"], fixture.activeWorktree);
    await git(["commit", "-m", "Second unmerged change"], fixture.activeWorktree);
    const sourceWorktreeId = (await inspectGitWorkspace(fixture.activeWorktree)).worktreeId;

    await assert.rejects(
      () => manager.removeMergedWorktree({
        logicalSessionId: "logical:one",
        sourceWorktreeId,
        ignoreLogicalSessionIds: ["logical:one"],
        deleteBranch: true
      }),
      /has 2 commits.*Confirm the full branch name/
    );
    await assert.rejects(
      () => manager.removeMergedWorktree({
        logicalSessionId: "logical:one",
        sourceWorktreeId,
        ignoreLogicalSessionIds: ["logical:one"],
        deleteBranch: true,
        forceDeleteUnmerged: true,
        acknowledgeIrrecoverable: true,
        confirmedBranchName: "feature/wrong-name"
      }),
      /Confirm the full branch name/
    );

    const removed = await manager.removeMergedWorktree({
      logicalSessionId: "logical:one",
      sourceWorktreeId,
      ignoreLogicalSessionIds: ["logical:one"],
      deleteBranch: true,
      forceDeleteUnmerged: true,
      acknowledgeIrrecoverable: true,
      confirmedBranchName: "feature/session-worktree"
    });
    assert.equal(removed.removed, true);
    assert.equal(removed.forced, true);
    assert.equal(removed.discardedCommitCount, 2);
    await assert.rejects(() => inspectGitWorkspace(fixture.activeWorktree));
    await assert.rejects(
      () => gitOutput(["rev-parse", "--verify", "feature/session-worktree"], fixture.repository)
    );
  } finally {
    await fixture.close();
  }
});

test("confirmed permanent deletion also discards uncommitted worktree changes", async () => {
  const fixture = await createFixture("force-delete-dirty", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    await writeFile(join(fixture.activeWorktree, "uncommitted.txt"), "discard me\n");
    const sourceWorktreeId = (await inspectGitWorkspace(fixture.activeWorktree)).worktreeId;
    await assert.rejects(
      () => manager.removeMergedWorktree({
        logicalSessionId: "logical:one",
        sourceWorktreeId,
        ignoreLogicalSessionIds: ["logical:one"],
        deleteBranch: true
      }),
      /and uncommitted changes/
    );
    const removed = await manager.removeMergedWorktree({
      logicalSessionId: "logical:one",
      sourceWorktreeId,
      ignoreLogicalSessionIds: ["logical:one"],
      deleteBranch: true,
      forceDeleteUnmerged: true,
      acknowledgeIrrecoverable: true,
      confirmedBranchName: "feature/session-worktree"
    });
    assert.equal(removed.forced, true);
    assert.equal(removed.discardedCommitCount, 0);
    await assert.rejects(() => inspectGitWorkspace(fixture.activeWorktree));
  } finally {
    await fixture.close();
  }
});

test("a manually deleted worktree can be rebuilt from its surviving branch", async () => {
  const fixture = await createFixture("restore-missing", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    await writeFile(join(fixture.activeWorktree, "preserved.txt"), "preserved by branch\n");
    await git(["add", "preserved.txt"], fixture.activeWorktree);
    await git(["commit", "-m", "Preserve branch content"], fixture.activeWorktree);
    await rm(fixture.activeWorktree, { recursive: true, force: true });

    const restored = await manager.restoreMissingWorktree({ logicalSessionId: "logical:one" });
    assert.equal(restored.restored.branchName, "feature/session-worktree");
    assert.equal(await readFile(join(fixture.activeWorktree, "preserved.txt"), "utf8"), "preserved by branch\n");
    const identity = await inspectGitWorkspace(fixture.activeWorktree);
    assert.equal(identity.worktreeId, restored.restored.worktreeId);
  } finally {
    await fixture.close();
  }
});

async function createFixture(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `corptie-git-workspace-${label}-`));
  const repository = join(directory, "main repo");
  await mkdir(repository);
  await git(["init", "-b", options.mainBranch ?? "main"], repository);
  await git(["commit", "--allow-empty", "-m", "initial"], repository);
  const activeWorktree = options.activeFeatureWorktree
    ? join(directory, "session worktree")
    : repository;
  if (options.activeFeatureWorktree) {
    await git(["worktree", "add", "-b", "feature/session-worktree", activeWorktree, "HEAD"], repository);
  }
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const snapshot = await createGitWorkspaceSnapshot(repository);
  store.upsertGitWorkspaceSnapshot(snapshot);
  const identity = await inspectGitWorkspace(activeWorktree);
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
    repositoryId: identity.repositoryId,
    activeWorktree,
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

async function gitOutput(arguments_, cwd) {
  const result = await execFileAsync("git", ["-C", cwd, ...arguments_], { encoding: "utf8" });
  return result.stdout;
}
