import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexWorkspaceTransitionManager } from "../src/runtime/codexWorkspaceTransitionManager.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("workspace transition waits for an active turn then atomically routes a fork", async () => {
  const fixture = await createFixture("success");
  const calls = [];
  const events = [];
  const codexClient = {
    async forkThread(threadId, options) {
      calls.push({ method: "fork", threadId, options });
      return {
        thread: { id: "thread-feature", cwd: fixture.feature },
        cwd: fixture.feature,
        runtimeWorkspaceRoots: [fixture.feature],
        instructionSources: [fixture.rootInstructions, fixture.featureInstructions],
        approvalPolicy: "on-request",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [fixture.feature],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      };
    },
    async updateThreadSettings(threadId, options) {
      calls.push({ method: "settings", threadId, options });
      return {};
    }
  };
  const manager = new CodexWorkspaceTransitionManager({
    store: fixture.store,
    codexClient,
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.featureInstructions
    ],
    onRouteCommitted: async (event) => events.push(event)
  });

  try {
    const waiting = await manager.switchWorkspace({
      transitionId: "transition:wait",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:feature",
      activeTurnId: "turn-active",
      lastCompletedTurnId: "turn-6"
    });
    assert.equal(waiting.status, "waitingForTurn");
    assert.equal(calls.length, 0);
    assert.equal(fixture.store.getLogicalSession("logical:one").activeThreadId, "thread-source");

    const result = await manager.continueWorkspaceTransition("transition:wait", {
      lastCompletedTurnId: "turn-7",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [fixture.feature],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    });
    assert.equal(result.status, "committed");
    assert.equal(result.logicalSession.activeThreadId, "thread-feature");
    assert.equal(result.logicalSession.activeWorkspaceId, "worktree:feature");
    assert.equal(result.logicalSession.routingVersion, 2);
    assert.equal(calls[0].method, "fork");
    assert.equal(calls[0].options.lastTurnId, "turn-7");
    assert.deepEqual(calls[0].options.runtimeWorkspaceRoots, [fixture.feature]);
    assert.equal(calls[1].method, "settings");
    assert.deepEqual(calls[1].options.sandboxPolicy.writableRoots, [fixture.feature]);
    assert.equal(events.length, 1);
    assert.equal(events[0].logicalSessionId, "logical:one");
    assert.match(events[0].transitionContext, new RegExp(fixture.feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await fixture.close();
  }
});

test("invalid fork instruction sources preserve the original route and retain an invalid child binding", async () => {
  const fixture = await createFixture("invalid");
  const manager = new CodexWorkspaceTransitionManager({
    store: fixture.store,
    codexClient: {
      async forkThread() {
        return {
          thread: { id: "thread-invalid", cwd: fixture.feature },
          cwd: fixture.feature,
          runtimeWorkspaceRoots: [fixture.feature],
          instructionSources: [fixture.sourceInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.feature] }
        };
      }
    },
    requiredInstructionSources: async () => [fixture.featureInstructions]
  });

  try {
    await assert.rejects(
      () => manager.switchWorkspace({
        transitionId: "transition:invalid",
        logicalSessionId: "logical:one",
        targetWorktreeId: "worktree:feature",
        lastCompletedTurnId: "turn-7"
      }),
      /invalid workspace instruction sources/
    );
    const logical = fixture.store.getLogicalSession("logical:one");
    assert.equal(logical.activeThreadId, "thread-source");
    assert.equal(logical.activeWorkspaceId, "worktree:main");
    assert.equal(logical.routingVersion, 1);
    assert.equal(logical.transitionState, "failed");
    assert.equal(fixture.store.getWorkspaceTransition("transition:invalid").phase, "failed");
    assert.equal(fixture.store.getProviderThreadBinding("thread-invalid").state, "invalid");
  } finally {
    await fixture.close();
  }
});

test("restart recovery resumes a validated fork and commits the stored transition", async () => {
  const fixture = await createFixture("recover-validating");
  fixture.store.beginWorkspaceTransition({
    transitionId: "transition:recover",
    logicalSessionId: "logical:one",
    targetWorktreeId: "worktree:feature",
    sourceRoutingVersion: 1,
    lastCompletedTurnId: "turn-7",
    phase: "forking"
  });
  fixture.store.updateWorkspaceTransition("transition:recover", {
    phase: "validatingInstructions",
    newThreadId: "thread-recovered"
  });
  const manager = new CodexWorkspaceTransitionManager({
    store: fixture.store,
    codexClient: {
      async resumeThread(threadId, options) {
        assert.equal(threadId, "thread-recovered");
        assert.equal(options.cwd, fixture.feature);
        return {
          thread: { id: threadId, cwd: fixture.feature },
          cwd: fixture.feature,
          runtimeWorkspaceRoots: [fixture.feature],
          instructionSources: [fixture.rootInstructions, fixture.featureInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.feature] }
        };
      }
    },
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.featureInstructions
    ]
  });

  try {
    const result = await manager.recoverWorkspaceTransition("transition:recover");
    assert.equal(result.status, "committed");
    assert.equal(result.logicalSession.activeThreadId, "thread-recovered");
    assert.equal(result.logicalSession.routingVersion, 2);
    assert.equal(result.event.recovered, true);
  } finally {
    await fixture.close();
  }
});

test("restart recovery fails an ambiguous forking journal without changing the source route", async () => {
  const fixture = await createFixture("recover-ambiguous");
  fixture.store.beginWorkspaceTransition({
    transitionId: "transition:ambiguous",
    logicalSessionId: "logical:one",
    targetWorktreeId: "worktree:feature",
    sourceRoutingVersion: 1,
    lastCompletedTurnId: "turn-7",
    phase: "forking"
  });
  const manager = new CodexWorkspaceTransitionManager({
    store: fixture.store,
    codexClient: {}
  });

  try {
    const result = await manager.recoverWorkspaceTransition("transition:ambiguous");
    assert.equal(result.status, "failed");
    assert.match(result.transition.error.message, /could not uniquely identify/);
    const logical = fixture.store.getLogicalSession("logical:one");
    assert.equal(logical.activeThreadId, "thread-source");
    assert.equal(logical.routingVersion, 1);
  } finally {
    await fixture.close();
  }
});

async function createFixture(label) {
  const directory = await mkdtemp(join(tmpdir(), `corptie-transition-${label}-`));
  const main = join(directory, "main worktree");
  const feature = join(directory, "feature worktree");
  await mkdir(main);
  await mkdir(feature);
  const rootInstructions = join(directory, "AGENTS.md");
  const sourceInstructions = join(main, "AGENTS.md");
  const featureInstructions = join(feature, "AGENTS.md");
  await Promise.all([
    writeFile(rootInstructions, "root"),
    writeFile(sourceInstructions, "source"),
    writeFile(featureInstructions, "feature")
  ]);
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  store.upsertGitWorkspaceSnapshot({
    repository: {
      id: "repository:one",
      commonGitDirCanonicalPath: join(directory, ".git"),
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:00:00.000Z"
    },
    inventoryVersion: "inventory:one",
    observedAt: "2026-07-28T00:00:00.000Z",
    worktrees: [
      workspaceRecord("worktree:main", main, join(directory, ".git"), true, "main"),
      workspaceRecord(
        "worktree:feature",
        feature,
        join(directory, ".git", "worktrees", "feature"),
        false,
        "feature/workspace"
      )
    ]
  });
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:one",
    providerThreadId: "thread-source",
    repositoryId: "repository:one",
    worktreeId: "worktree:main",
    boundCwd: main,
    instructionSources: [rootInstructions, sourceInstructions],
    permissionSnapshot: {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [main] }
    }
  });
  return {
    directory,
    main,
    feature,
    rootInstructions,
    sourceInstructions,
    featureInstructions,
    store,
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function workspaceRecord(worktreeId, path, gitDirCanonicalPath, isMain, branchName) {
  return {
    worktreeId,
    path,
    canonicalPath: path,
    gitDirCanonicalPath,
    isMain,
    availability: "available",
    headOid: "abc123",
    branchRef: `refs/heads/${branchName}`,
    branchName,
    isDetached: false,
    isLocked: false,
    lockReason: null,
    isPrunable: false,
    pruneReason: null
  };
}
