import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import {
  conflictResolutionWritableRoots,
  isConflictResolutionWorkspace,
  upgradeConflictResolutionWritableRoots
} from "../src/runtime/conflictResolutionWorkspacePermissions.mjs";
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

test("Task deletion status inspects only the known target Worktree without rebuilding inventory", async () => {
  const fixture = await createFixture("task-delete-targeted", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") },
    createSnapshot: async () => assert.fail("Task deletion must not rebuild the full Worktree inventory")
  });
  await writeFile(join(fixture.activeWorktree, "draft.txt"), "keep or delete\n");
  try {
    const project = await manager.taskDeletionStatus("logical:one");
    assert.equal(project.worktrees.length, 1);
    assert.equal(project.worktrees[0].path, await realpath(fixture.activeWorktree));
    assert.equal(project.worktrees[0].dirty, true);
    assert.match(project.worktrees[0].statusSummary, /draft\.txt/);
  } finally {
    await fixture.close();
  }
});

test("project status distinguishes working, pending, and synchronized worktrees", async () => {
  const fixture = await createFixture("project-status", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") },
    inspectionCacheTtlMs: 0
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

test("project inspection merges 1, 3, and 5 concurrent clients and caches within the TTL", async () => {
  for (const clientCount of [1, 3, 5]) {
    const fixture = await createFixture(`single-flight-${clientCount}`, { activeFeatureWorktree: true });
    let snapshotCount = 0;
    let releaseSnapshot;
    const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
    const manager = new GitWorkspaceManager({
      store: fixture.store,
      transitions: { switchWorkspace: async () => assert.fail("must not switch") },
      inspectionCacheTtlMs: 1_000,
      createSnapshot: async (...args) => {
        snapshotCount += 1;
        await snapshotGate;
        return createGitWorkspaceSnapshot(...args);
      }
    });
    try {
      const requests = Array.from({ length: clientCount }, () => manager.projectStatusForPath(
        fixture.repository,
        fixture.repositoryId,
        { inspectionLevel: "management", reason: "concurrent_test" }
      ));
      releaseSnapshot();
      const results = await Promise.all(requests);
      assert.equal(snapshotCount, 1, `${clientCount} clients must share one scan`);
      assert.ok(results.every((result) => result === results[0]));
      await manager.projectStatusForPath(fixture.repository, fixture.repositoryId, {
        inspectionLevel: "management",
        reason: "ttl_cache_test"
      });
      assert.equal(snapshotCount, 1);
      const metrics = manager.inspectionPerformanceSnapshot();
      assert.equal(metrics.scans, 1);
      assert.equal(metrics.singleFlightHits, Math.max(0, clientCount - 1));
      assert.equal(metrics.cacheHits, 1);
    } finally {
      await fixture.close();
    }
  }
});

test("inspection TTL expiry and precise Git-write invalidation force a new scan", async () => {
  const fixture = await createFixture("inspection-expiry", { activeFeatureWorktree: true });
  let now = 1_000;
  let snapshotCount = 0;
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") },
    inspectionCacheTtlMs: 50,
    now: () => now,
    createSnapshot: async (...args) => {
      snapshotCount += 1;
      return createGitWorkspaceSnapshot(...args);
    }
  });
  try {
    const inspect = () => manager.projectStatusForPath(fixture.repository, fixture.repositoryId, {
      inspectionLevel: "management",
      reason: "expiry_test"
    });
    await inspect();
    await inspect();
    assert.equal(snapshotCount, 1);
    now += 51;
    await inspect();
    assert.equal(snapshotCount, 2);
    manager.invalidateInspectionCache(fixture.repositoryId, "test_git_write");
    await inspect();
    assert.equal(snapshotCount, 3);
  } finally {
    await fixture.close();
  }
});

test("management inspection keeps a longer snapshot cache and supports an explicit fresh scan", async () => {
  const fixture = await createFixture("management-cache-policy", { activeFeatureWorktree: true });
  let now = 1_000;
  let snapshotCount = 0;
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") },
    inspectionCacheTtlMs: 5,
    now: () => now,
    createSnapshot: async (...args) => {
      snapshotCount += 1;
      return createGitWorkspaceSnapshot(...args);
    }
  });
  try {
    await manager.managementInspectionForProject(fixture.repository, fixture.repositoryId);
    now += 10;
    await manager.managementInspectionForProject(fixture.repository, fixture.repositoryId);
    assert.equal(snapshotCount, 1);
    await manager.managementInspectionForProject(fixture.repository, fixture.repositoryId, {
      forceFresh: true
    });
    assert.equal(snapshotCount, 2);
  } finally {
    await fixture.close();
  }
});

test("commit and workspace switch invalidate only the affected repository inspection cache", async () => {
  const fixture = await createFixture("operation-invalidation", { activeFeatureWorktree: true });
  let snapshotCount = 0;
  let switchCount = 0;
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => { switchCount += 1; return { status: "switched" }; } },
    inspectionCacheTtlMs: 60_000,
    createSnapshot: async (...args) => {
      snapshotCount += 1;
      return createGitWorkspaceSnapshot(...args);
    }
  });
  const inspect = () => manager.projectStatusForPath(fixture.repository, fixture.repositoryId, {
    inspectionLevel: "management",
    reason: "operation_invalidation_test"
  });
  try {
    const initial = await inspect();
    const feature = initial.worktrees.find((worktree) => !worktree.isMain);
    await inspect();
    assert.equal(snapshotCount, 1);
    await writeFile(join(fixture.activeWorktree, "invalidate.txt"), "changed\n");
    await manager.commitWorktreeChangesForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      sourceWorktreeId: feature.worktreeId,
      commitMessage: "Invalidate cached inspection"
    });
    await inspect();
    assert.equal(snapshotCount, 2);
    await manager.switchWorkspace({
      logicalSessionId: "logical:one",
      targetWorktreeId: feature.worktreeId
    });
    await inspect();
    assert.equal(snapshotCount, 3);
    assert.equal(switchCount, 1);
  } finally {
    await fixture.close();
  }
});

test("session inspection probes status only for main and the active Worktree", async () => {
  const fixture = await createFixture("session-level", { activeFeatureWorktree: true });
  const calls = [];
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") },
    execFile: async (file, args, options) => {
      if (["status", "rev-list", "diff"].includes(args[2])) calls.push([args[1], ...args.slice(2)]);
      return execFileAsync(file, args, options);
    }
  });
  try {
    const active = await inspectGitWorkspace(fixture.activeWorktree);
    const result = await manager.projectStatusForPath(fixture.repository, fixture.repositoryId, {
      inspectionLevel: "session",
      activeWorkspaceId: active.worktreeId,
      reason: "session_detail_test"
    });
    assert.equal(result.worktrees.length, 2);
    assert.deepEqual(new Set(calls.filter((call) => call[1] === "status").map((call) => call[0])),
      new Set([await realpath(fixture.repository), await realpath(fixture.activeWorktree)]));
  } finally {
    await fixture.close();
  }
});

test("management inspection preserves list fields while avoiding deep per-Worktree Git probes", async () => {
  const fixture = await createFixture("management-inspection", { activeFeatureWorktree: true });
  const calls = [];
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") },
    execFile: async (file, args, options) => {
      calls.push(args.slice(2));
      return execFileAsync(file, args, options);
    }
  });
  try {
    await writeFile(join(fixture.activeWorktree, "working.txt"), "working\n");
    const summary = await manager.managementInspectionForProject(
      fixture.repository,
      fixture.repositoryId
    );
    const summaryCalls = structuredClone(calls);
    calls.length = 0;
    const deep = await manager.integrationInspectionForProject(
      fixture.repository,
      fixture.repositoryId
    );

    const listFields = (inspection) => inspection.worktrees.map((worktree) => ({
      worktreeId: worktree.worktreeId,
      path: worktree.path,
      branchName: worktree.branchName,
      headOid: worktree.headOid,
      isMain: worktree.isMain,
      state: worktree.state,
      dirty: worktree.dirty,
      aheadOfMain: worktree.aheadOfMain,
      behindMain: worktree.behindMain,
      mergedIntoMain: worktree.mergedIntoMain,
      synchronizedWithMain: worktree.synchronizedWithMain,
      pendingIntegration: worktree.pendingIntegration,
      changedFiles: worktree.changedFiles,
      operationState: worktree.operationState,
      sessions: worktree.sessions
    }));
    assert.deepEqual(listFields(summary), listFields(deep));
    assert.deepEqual(
      summaryCalls.filter((args) => ["rev-list", "status"].includes(args[0])).map((args) => args[0]).sort(),
      ["rev-list", "status", "status"]
    );
    assert.equal(summaryCalls.some((args) => args[0] === "diff"), false);
    assert.equal(summaryCalls.some((args) => args[0] === "merge-base"), false);
    assert.equal(summaryCalls.filter((args) => args[0] === "rev-parse").length, 3);
    assert.equal(summaryCalls.filter((args) => args[0] === "worktree").length, 1);
    assert.ok(calls.length >= summaryCalls.length + summary.worktrees.length * 2);
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
        assert.match(error.message, /CONFLICT .*shared\.txt/);
        assert.match(error.message, /Automatic merge failed/);
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

test("Agent conflict delegation safely moves a task-owned merge into a dedicated Integration Worktree", async () => {
  const fixture = await createFixture("agent-conflict", { activeFeatureWorktree: true });
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
    const mainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();
    const sourceHead = (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim();
    await assert.rejects(
      () => manager.mergeIntegrationSource({
        mainPath: fixture.repository,
        sourceHead,
        expectedMainHead: mainHead,
        jobId: "worktree_integration:agent-conflict"
      }),
      (error) => error?.code === "MERGE_CONFLICT"
    );

    const workspace = await manager.prepareIntegrationConflictResolutionForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      sourceHead,
      expectedMainHead: mainHead,
      jobId: "worktree_integration:agent-conflict"
    });

    assert.match(workspace.branchName, /^integration\/worktree-integration-/);
    assert.equal(workspace.headOid, mainHead);
    assert.equal((await gitOutput(["status", "--porcelain=v1"], fixture.repository)).trim(), "");
    await assert.rejects(() => gitOutput(["rev-parse", "-q", "--verify", "MERGE_HEAD"], fixture.repository));
  } finally {
    await fixture.close();
  }
});

test("verified Agent resolution stays isolated until the backend promotes its Integration commit", async () => {
  const fixture = await createFixture("agent-resolution-promotion", { activeFeatureWorktree: true });
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
    const expectedMainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();
    const sourceHead = (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim();
    await assert.rejects(
      () => manager.mergeIntegrationSource({
        mainPath: fixture.repository, sourceHead, expectedMainHead, jobId: "job:agent-resolution"
      }),
      { code: "MERGE_CONFLICT" }
    );
    const workspace = await manager.prepareIntegrationConflictResolutionForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      sourceHead,
      expectedMainHead,
      jobId: "job:agent-resolution"
    });

    await assert.rejects(() => git(["merge", "--no-ff", "--no-edit", sourceHead], workspace.path));
    await writeFile(join(workspace.path, "shared.txt"), "main and feature\n");
    await git(["add", "shared.txt"], workspace.path);
    await git(["commit", "--no-edit"], workspace.path);

    assert.equal((await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim(), expectedMainHead);
    assert.equal((await gitOutput(["status", "--porcelain=v1"], fixture.repository)).trim(), "");
    const verified = await manager.inspectIntegrationConflictResolutionForProject({
      repositoryId: fixture.repositoryId,
      mainPath: fixture.repository,
      workspace,
      sourceHead,
      expectedMainHead
    });
    assert.equal(verified.resolvedHead, (await gitOutput(["rev-parse", "HEAD"], workspace.path)).trim());

    const promoted = await manager.mergeIntegrationSource({
      mainPath: fixture.repository,
      sourceHead: verified.resolvedHead,
      expectedMainHead,
      jobId: "job:agent-resolution"
    });
    assert.equal(promoted.merged, true);
    assert.equal(await readFile(join(fixture.repository, "shared.txt"), "utf8"), "main and feature\n");
    await git(["merge-base", "--is-ancestor", sourceHead, "HEAD"], fixture.repository);
  } finally {
    await fixture.close();
  }
});

test("conflict workspace writable roots permit merge and commit without exposing Worktree deletion metadata", async () => {
  const fixture = await createFixture("agent-resolution-metadata-permissions", { activeFeatureWorktree: true });
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

  let commonGitDir = null;
  try {
    const expectedMainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();
    const sourceHead = (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim();
    const workspace = await manager.createIntegrationWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      runId: "integration:metadata-permissions"
    });
    const identity = await inspectGitWorkspace(workspace.path);
    commonGitDir = identity.commonGitDirCanonicalPath;
    const writableRoots = await conflictResolutionWritableRoots({
      path: workspace.path,
      worktreeId: workspace.worktreeId
    });

    assert.equal(writableRoots.includes(identity.gitDirCanonicalPath), true);
    assert.equal(writableRoots.includes(commonGitDir), false);
    assert.equal(writableRoots.includes(join(commonGitDir, "worktrees")), false);
    assert.equal(writableRoots.includes(fixture.repository), false);
    const legacyPath = "/tmp/corptie-integration-worktree-integration-efd";
    assert.deepEqual(await upgradeConflictResolutionWritableRoots({
      path: legacyPath,
      worktreeId: workspace.worktreeId
    }, [legacyPath], async () => identity, async () => workspace.branchName), writableRoots);
    assert.equal(await isConflictResolutionWorkspace({
      path: legacyPath,
      worktreeId: workspace.worktreeId
    }, async () => identity, async () => workspace.branchName), true);
    assert.equal(await isConflictResolutionWorkspace({
      path: fixture.activeWorktree,
      worktreeId: identity.worktreeId
    }, async () => identity, async () => "integration/not-enough"), false);

    await execFileAsync("chmod", ["-R", "a-w", commonGitDir]);
    for (const root of writableRoots.slice(1)) {
      await execFileAsync("chmod", ["-R", "u+w", root]);
    }
    await assert.rejects(() => git(["merge", "--no-ff", "--no-edit", sourceHead], workspace.path));
    await writeFile(join(workspace.path, "shared.txt"), "main and feature\n");
    await git(["add", "shared.txt"], workspace.path);
    await git(["commit", "--no-edit"], workspace.path);
    await git(["merge-base", "--is-ancestor", sourceHead, "HEAD"], workspace.path);
    assert.equal((await gitOutput(["status", "--porcelain=v1"], workspace.path)).trim(), "");
  } finally {
    if (commonGitDir) await execFileAsync("chmod", ["-R", "u+w", commonGitDir]).catch(() => {});
    await fixture.close();
  }
});

test("Agent conflict delegation recognizes a source already merged after the recorded conflict", async () => {
  const fixture = await createFixture("externally-resolved-conflict", { activeFeatureWorktree: true });
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
    const expectedMainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();
    const sourceHead = (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim();
    await assert.rejects(
      () => manager.mergeIntegrationSource({
        mainPath: fixture.repository, sourceHead, expectedMainHead, jobId: "job:external"
      }),
      (error) => error?.code === "MERGE_CONFLICT"
    );
    await git(["merge", "--abort"], fixture.repository);
    await git(["merge", "-s", "ours", "--no-edit", sourceHead], fixture.repository);

    const result = await manager.prepareIntegrationConflictResolutionForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      sourceHead,
      expectedMainHead,
      jobId: "job:external"
    });

    assert.equal(result.alreadyResolved, true);
    assert.equal(result.mainHead, (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim());
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

test("Integration Worktree allocation suffixes an occupied branch and path without deleting either", async () => {
  const fixture = await createFixture("integration-worktree-occupied");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await git(["branch", "integration/run-one"], fixture.repository);
  try {
    const created = await manager.createIntegrationWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      runId: "integration:run-one"
    });
    assert.equal(created.branchName, "integration/run-one-2");
    assert.equal(created.retryCount, 1);
    assert.equal(created.reused, false);
    await git(["show-ref", "--verify", "refs/heads/integration/run-one"], fixture.repository);
    await git(["show-ref", "--verify", "refs/heads/integration/run-one-2"], fixture.repository);
  } finally {
    await fixture.close();
  }
});

test("retry reuses an intact Integration Worktree while concurrent distinct tasks get unique identifiers", async () => {
  const fixture = await createFixture("integration-worktree-concurrent");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const first = await manager.createIntegrationWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      runId: "integration:retryable"
    });
    const reused = await manager.createIntegrationWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      runId: "integration:retryable"
    });
    assert.equal(reused.worktreeId, first.worktreeId);
    assert.equal(reused.reused, true);

    const [left, right] = await Promise.all([
      manager.createIntegrationWorktreeForProject({
        repositoryId: fixture.repositoryId,
        workingDirectory: fixture.repository,
        runId: "integration:parallel-left"
      }),
      manager.createIntegrationWorktreeForProject({
        repositoryId: fixture.repositoryId,
        workingDirectory: fixture.repository,
        runId: "integration:parallel-right"
      })
    ]);
    assert.notEqual(left.worktreeId, right.worktreeId);
    assert.notEqual(left.branchName, right.branchName);
    assert.notEqual(left.path, right.path);
  } finally {
    await fixture.close();
  }
});

test("one plan advances and reuses the same clean Integration Worktree for later conflicts", async () => {
  const fixture = await createFixture("integration-worktree-plan-reuse");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const first = await manager.createIntegrationWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      runId: "integration:whole-plan"
    });
    await writeFile(join(fixture.repository, "main-advanced.txt"), "next merge\n");
    await git(["add", "main-advanced.txt"], fixture.repository);
    await git(["commit", "-m", "Advance main after first resolved conflict"], fixture.repository);
    const mainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();

    const reused = await manager.createIntegrationWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      runId: "integration:whole-plan"
    });

    assert.equal(reused.worktreeId, first.worktreeId);
    assert.equal(reused.path, first.path);
    assert.equal(reused.branchName, first.branchName);
    assert.equal(reused.headOid, mainHead);
    assert.equal(reused.reused, true);
  } finally {
    await fixture.close();
  }
});

test("ensures one deterministic Task Worktree and reuses it on retry", async () => {
  const fixture = await createFixture("task-worktree");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const created = await manager.ensureTaskWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      taskId: "task:one"
    });
    const retried = await manager.ensureTaskWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      taskId: "task:one"
    });

    assert.equal(created.branchName, "task/one");
    assert.equal(created.reused, false);
    assert.equal(retried.reused, true);
    assert.equal(retried.worktreeId, created.worktreeId);
    assert.equal(retried.path, created.path);
    const root = join(fixture.directory, `.corptie-worktrees-${fixture.repositoryId.split(":").at(-1)}`);
    assert.equal(created.path, await realpath(join(root, "one")));
    assert.equal((await gitOutput(["rev-parse", "HEAD"], created.path)).trim(), created.headOid);
    assert.equal((await gitOutput(["branch", "--show-current"], created.path)).trim(), "task/one");
  } finally {
    await fixture.close();
  }
});

test("an unborn repository starts its first Task in the main checkout without inventing a commit", async () => {
  const fixture = await createFixture("task-unborn", { initialCommit: false });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  await writeFile(join(fixture.repository, "untracked-project.txt"), "bootstrap project\n");
  try {
    const prepared = await manager.ensureTaskWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      taskId: "task:bootstrap"
    });

    assert.equal(prepared.worktreeId, (await inspectGitWorkspace(fixture.repository)).worktreeId);
    assert.equal(prepared.path, await realpath(fixture.repository));
    assert.equal(prepared.branchName, "main");
    assert.equal(prepared.headOid, null);
    assert.equal(prepared.reused, true);
    assert.equal(prepared.workspaceMode, "unborn-main");
    assert.equal(await readFile(join(prepared.path, "untracked-project.txt"), "utf8"), "bootstrap project\n");
    assert.equal((await gitOutput(["worktree", "list", "--porcelain"], fixture.repository)).match(/^worktree /gm)?.length, 1);
    await assert.rejects(() => gitOutput(["rev-parse", "--verify", "HEAD"], fixture.repository));

    const project = await manager.projectStatusForPath(fixture.repository, fixture.repositoryId);
    assert.equal(project.mainHeadOid, null);
    assert.equal(project.worktrees.length, 1);
    assert.equal(project.worktrees[0].headOid, null);
    assert.equal(project.worktrees[0].state, "mainDirty");
  } finally {
    await fixture.close();
  }
});

test("creates Task Worktrees inside a missing managed non-nested root for paths with spaces and non-ASCII characters", async () => {
  const fixture = await createFixture("task-unicode", { repositoryName: "主项目 repo" });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  const root = join(fixture.directory, `.corptie-worktrees-${fixture.repositoryId.split(":").at(-1)}`);
  try {
    await assert.rejects(() => realpath(root), { code: "ENOENT" });
    const created = await manager.ensureTaskWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      taskId: "task:路径 one"
    });

    assert.equal(created.path, await realpath(join(root, "one-0b60f425b4")));
    assert.equal(created.branchName, "task/one-0b60f425b4");
    assert.equal((await gitOutput(["rev-parse", "--show-toplevel"], created.path)).trim(), created.path);
    assert.equal((await gitOutput(["status", "--porcelain=v1"], created.path)).trim(), "");
  } finally {
    await fixture.close();
  }
});

test("allocates distinct Task Worktrees for names that normalize to the same readable suffix", async () => {
  const fixture = await createFixture("task-distinct");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    const first = await manager.ensureTaskWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      taskId: "task:duplicate name"
    });
    const second = await manager.ensureTaskWorktreeForProject({
      repositoryId: fixture.repositoryId,
      workingDirectory: fixture.repository,
      taskId: "task:duplicate-name"
    });

    assert.notEqual(first.path, second.path);
    assert.notEqual(first.branchName, second.branchName);
    assert.equal((await gitOutput(["branch", "--show-current"], first.path)).trim(), first.branchName);
    assert.equal((await gitOutput(["branch", "--show-current"], second.path)).trim(), second.branchName);
  } finally {
    await fixture.close();
  }
});

test("refuses a managed Task Worktree root nested inside any registered Worktree", async () => {
  const fixture = await createFixture("task-nested-root");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") },
    taskWorktreesRoot: join(fixture.repository, ".corptie", "worktrees")
  });
  try {
    await assert.rejects(
      () => manager.ensureTaskWorktreeForProject({
        repositoryId: fixture.repositoryId,
        workingDirectory: fixture.repository,
        taskId: "task:nested"
      }),
      /must not be nested inside another Git Worktree/
    );
    assert.equal((await gitOutput(["worktree", "list", "--porcelain"], fixture.repository)).match(/^worktree /gm)?.length, 1);
  } finally {
    await fixture.close();
  }
});

test("reports an explicit error when the managed Worktree target is occupied", async () => {
  const fixture = await createFixture("task-conflict");
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  const root = join(fixture.directory, `.corptie-worktrees-${fixture.repositoryId.split(":").at(-1)}`);
  const occupied = join(root, "occupied");
  try {
    await mkdir(occupied, { recursive: true });
    await assert.rejects(
      () => manager.ensureTaskWorktreeForProject({
        repositoryId: fixture.repositoryId,
        workingDirectory: fixture.repository,
        taskId: "task:occupied"
      }),
      (error) => error?.message?.includes("worktree target path already exists:")
        && error.message.endsWith("/occupied")
    );
    await assert.rejects(() => gitOutput(["show-ref", "--verify", "refs/heads/task/occupied"], fixture.repository));
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

test("safe-only deletion blocks uncommitted changes even when force flags are supplied", async () => {
  const fixture = await createFixture("safe-delete-dirty", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    await writeFile(join(fixture.activeWorktree, "uncommitted.txt"), "keep me\n");
    const sourceWorktreeId = (await inspectGitWorkspace(fixture.activeWorktree)).worktreeId;
    await assert.rejects(
      () => manager.removeMergedWorktree({
        logicalSessionId: "logical:one",
        sourceWorktreeId,
        ignoreLogicalSessionIds: ["logical:one"],
        deleteBranch: true,
        safeOnly: true,
        forceDeleteUnmerged: true,
        acknowledgeIrrecoverable: true,
        confirmedBranchName: "feature/session-worktree"
      }),
      (error) => error.code === "UNCOMMITTED_CHANGES" && /uncommitted changes/.test(error.message)
    );
    assert.match(await gitOutput(["status", "--porcelain"], fixture.activeWorktree), /uncommitted\.txt/);
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

test("integration commit is traceable and a retry recognizes its persisted job marker", async () => {
  const fixture = await createFixture("integration-commit-marker", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    await writeFile(join(fixture.activeWorktree, "traceable.txt"), "traceable\n");
    const expectedHead = (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim();
    const expectedStatusSummary = (await gitOutput(["status", "--porcelain=v1"], fixture.activeWorktree)).trim();
    let protectionPrepared = false;
    const first = await manager.commitIntegrationChanges({
      path: fixture.activeWorktree,
      expectedHead,
      expectedStatusSummary,
      commitMessage: "Corptie: preserve changes in feature/session-worktree",
      prepare: async () => {
        protectionPrepared = true;
        await writeFile(join(fixture.activeWorktree, ".gitignore"), "/.corptie\n");
      },
      jobId: "job:traceable"
    });
    assert.equal(first.committed, true);
    assert.equal(protectionPrepared, true);
    assert.equal(
      (await gitOutput(["show", "--format=", "--name-only", "HEAD"], fixture.activeWorktree)).includes(".gitignore"),
      true
    );
    assert.match(
      await gitOutput(["show", "-s", "--format=%B", "HEAD"], fixture.activeWorktree),
      /Corptie-Integration-Job: job:traceable/
    );

    const recovered = await manager.commitIntegrationChanges({
      path: fixture.activeWorktree,
      expectedHead,
      expectedStatusSummary,
      commitMessage: "Corptie: preserve changes in feature/session-worktree",
      jobId: "job:traceable"
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.headOid, first.headOid);
  } finally {
    await fixture.close();
  }
});

test("integration merge keeps conflicts in main and safely finishes them on retry", async () => {
  const fixture = await createFixture("integration-conflict-preserved", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    await writeFile(join(fixture.repository, "shared.txt"), "main\n");
    await git(["add", "shared.txt"], fixture.repository);
    await git(["commit", "-m", "main version"], fixture.repository);
    await writeFile(join(fixture.activeWorktree, "shared.txt"), "feature\n");
    await git(["add", "shared.txt"], fixture.activeWorktree);
    await git(["commit", "-m", "feature version"], fixture.activeWorktree);
    const expectedMainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();
    const sourceHead = (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim();

    await assert.rejects(
      () => manager.mergeIntegrationSource({
        mainPath: fixture.repository, sourceHead, expectedMainHead, jobId: "job:conflict"
      }),
      (error) => error.code === "MERGE_CONFLICT" && error.conflictFiles.includes("shared.txt")
    );
    assert.equal(
      (await gitOutput(["rev-parse", "--verify", "MERGE_HEAD"], fixture.repository)).trim(),
      sourceHead
    );
    assert.match((await gitOutput(["status", "--porcelain=v1"], fixture.repository)).trim(), /^AA shared\.txt$/);

    await writeFile(join(fixture.repository, "shared.txt"), "main and feature\n");
    await git(["add", "shared.txt"], fixture.repository);
    const completed = await manager.mergeIntegrationSource({
      mainPath: fixture.repository, sourceHead, expectedMainHead, jobId: "job:conflict"
    });
    assert.equal(completed.recovered, true);
    assert.equal(await readFile(join(fixture.repository, "shared.txt"), "utf8"), "main and feature\n");
    await git(["merge-base", "--is-ancestor", sourceHead, "HEAD"], fixture.repository);
  } finally {
    await fixture.close();
  }
});

test("replanning aborts only the recorded task-owned integration merge and restores clean main", async () => {
  const fixture = await createFixture("integration-conflict-abort", { activeFeatureWorktree: true });
  const manager = new GitWorkspaceManager({
    store: fixture.store,
    transitions: { switchWorkspace: async () => assert.fail("must not switch") }
  });
  try {
    await writeFile(join(fixture.repository, "shared.txt"), "main\n");
    await git(["add", "shared.txt"], fixture.repository);
    await git(["commit", "-m", "main version"], fixture.repository);
    await writeFile(join(fixture.activeWorktree, "shared.txt"), "feature\n");
    await git(["add", "shared.txt"], fixture.activeWorktree);
    await git(["commit", "-m", "feature version"], fixture.activeWorktree);
    const expectedMainHead = (await gitOutput(["rev-parse", "HEAD"], fixture.repository)).trim();
    const sourceHead = (await gitOutput(["rev-parse", "HEAD"], fixture.activeWorktree)).trim();

    await assert.rejects(
      () => manager.mergeIntegrationSource({
        mainPath: fixture.repository, sourceHead, expectedMainHead, jobId: "job:conflict-abort"
      }),
      { code: "MERGE_CONFLICT" }
    );
    const aborted = await manager.abortIntegrationMerge({
      mainPath: fixture.repository, sourceHead, expectedMainHead, jobId: "job:conflict-abort"
    });

    assert.equal(aborted.aborted, true);
    assert.equal(aborted.mainHead, expectedMainHead);
    await assert.rejects(() => gitOutput(["rev-parse", "--verify", "MERGE_HEAD"], fixture.repository));
    assert.equal((await gitOutput(["status", "--porcelain=v1"], fixture.repository)).trim(), "");
  } finally {
    await fixture.close();
  }
});

async function createFixture(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `corptie-git-workspace-${label}-`));
  const repository = join(directory, options.repositoryName ?? "main repo");
  await mkdir(repository);
  await git(["init", "-b", options.mainBranch ?? "main"], repository);
  if (options.initialCommit !== false) {
    await git(["commit", "--allow-empty", "-m", "initial"], repository);
  }
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
