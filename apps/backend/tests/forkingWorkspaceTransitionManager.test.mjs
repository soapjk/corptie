import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ForkingWorkspaceTransitionManager,
  isForkUnsupported,
  rewriteWorkspacePath,
  workspaceHandoffPrompt
} from "../src/runtime/forkingWorkspaceTransitionManager.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { toolDefinitionsContractHash } from "../src/application/hostToolCatalog.mjs";

test("workspace transition waits for an active turn then atomically routes a fork", async () => {
  const fixture = await createFixture("success");
  const calls = [];
  const events = [];
  const providerPort = {
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
    },
    async deleteThread(threadId) {
      calls.push({ method: "delete", threadId });
      return {};
    }
  };
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort,
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
    assert.equal(calls[0].options.deferGoalContinuation, true);
    assert.equal(result.transition.resumeGoalAfterTransition, true);
    assert.deepEqual(calls[0].options.runtimeWorkspaceRoots, [fixture.feature]);
    assert.equal(calls[1].method, "settings");
    assert.deepEqual(calls[1].options.sandboxPolicy.writableRoots, [fixture.feature]);
    assert.equal(calls[2].method, "delete");
    assert.equal(calls[2].threadId, "thread-source");
    assert.equal(events.length, 1);
    assert.equal(events[0].logicalSessionId, "logical:one");
    assert.equal(events[0].sourceThreadDeleted, true);
    assert.equal(events[0].deletedProviderThreadId, "thread-source");
    assert.match(events[0].transitionContext, new RegExp(fixture.feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await fixture.close();
  }
});

test("a Git workspace session restarts its thread while preserving context", async () => {
  const fixture = await createFixture("restart");
  const calls = [];
  const materializations = [];
  const committedBindings = [];
  const transitionUpdates = [];
  const dynamicTools = [{ name: "corptie_tool_gateway" }];
  const sourceProof = toolProof("thread-source", dynamicTools, "thread-start");
  const childProof = toolProof("thread-restarted", dynamicTools, "thread-fork-inherited");
  const commitWorkspaceTransition = fixture.store.commitWorkspaceTransition.bind(fixture.store);
  fixture.store.commitWorkspaceTransition = (transitionId, binding) => {
    committedBindings.push(binding);
    return commitWorkspaceTransition(transitionId, { ...binding, toolMaterialization: null });
  };
  const updateWorkspaceTransition = fixture.store.updateWorkspaceTransition.bind(fixture.store);
  fixture.store.updateWorkspaceTransition = (transitionId, update) => {
    transitionUpdates.push(update);
    return updateWorkspaceTransition(transitionId, update);
  };
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async forkThread(threadId, options) {
        calls.push({ threadId, options });
        return {
          thread: { id: "thread-restarted", cwd: fixture.main },
          cwd: fixture.main,
          runtimeWorkspaceRoots: [fixture.main],
          instructionSources: [fixture.rootInstructions, fixture.sourceInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.main] }
        };
      }
    },
    confirmToolSchema: async ({ threadId, dynamicTools: definitions }) => {
      assert.equal(threadId, "thread-restarted");
      assert.deepEqual(definitions, dynamicTools);
      return childProof;
    },
    prepareToolMaterialization: async (input) => {
      materializations.push(input);
      return { status: "applied", providerReceipt: input.dynamicToolConfirmation };
    },
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.sourceInstructions
    ]
  });

  try {
    const result = await manager.restartSession({
      transitionId: "transition:restart",
      logicalSessionId: "logical:one",
      lastCompletedTurnId: "turn-7",
      dynamicTools,
      dynamicToolConfirmation: sourceProof,
      dynamicToolAgentId: "agent:one",
      dynamicToolMetadata: { sessionId: "session:one" }
    });
    assert.equal(result.status, "committed");
    assert.equal(result.logicalSession.activeThreadId, "thread-restarted");
    assert.equal(result.logicalSession.activeWorkspaceId, "worktree:main");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadId, "thread-source");
    assert.equal(calls[0].options.lastTurnId, "turn-7");
    assert.equal(calls[0].options.cwd, fixture.main);
    assert.equal(calls[0].options.deferGoalContinuation, true);
    assert.deepEqual(calls[0].options.dynamicTools, dynamicTools);
    assert.deepEqual(calls[0].options.dynamicToolConfirmation, sourceProof);
    assert.equal(calls[0].options.dynamicToolAgentId, "agent:one");
    assert.equal(calls[0].options.dynamicToolMetadata.sessionId, "session:one");
    assert.equal(calls[0].options.dynamicToolMetadata.providerBindingId, committedBindings[0].bindingId);
    assert.equal(calls[0].options.dynamicToolMetadata.routingVersion, 2);
    assert.equal(calls[0].options.dynamicToolMetadata.bindingGeneration, 2);
    assert.equal(materializations.length, 1);
    assert.equal(materializations[0].binding.providerThreadId, "thread-restarted");
    assert.equal(materializations[0].binding.bindingId, committedBindings[0].bindingId);
    assert.deepEqual(materializations[0].dynamicToolConfirmation, {
      ...childProof,
      providerDefinitionsCount: 1,
      providerObservationKind: "thread_fork_inherited"
    });
    assert.deepEqual(committedBindings[0].toolMaterialization, {
      status: "applied",
      providerReceipt: materializations[0].dynamicToolConfirmation
    });
    assert.ok(transitionUpdates.some((update) => (
      update.newThreadId === "thread-restarted"
      && update.toolConfirmation?.providerRevision === childProof.providerRevision
    )));
    assert.equal(result.transition.resumeGoalAfterTransition, false);
  } finally {
    await fixture.close();
  }
});

test("a session in a regular directory restarts without a Git worktree", async () => {
  const fixture = await createDirectoryFixture("non-git-restart");
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async forkThread(threadId, options) {
        assert.equal(threadId, "thread-source");
        assert.equal(options.cwd, fixture.workspace);
        assert.equal(options.lastTurnId, "turn-4");
        return {
          thread: { id: "thread-restarted", cwd: fixture.workspace },
          cwd: fixture.workspace,
          runtimeWorkspaceRoots: [fixture.workspace],
          instructionSources: [fixture.instructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.workspace] }
        };
      }
    },
    requiredInstructionSources: async () => [fixture.instructions]
  });

  try {
    const result = await manager.restartSession({
      transitionId: "transition:non-git-restart",
      logicalSessionId: "logical:directory",
      lastCompletedTurnId: "turn-4"
    });
    assert.equal(result.status, "committed");
    assert.equal(result.logicalSession.activeThreadId, "thread-restarted");
    assert.equal(result.logicalSession.activeWorkspaceId, null);
    assert.equal(result.logicalSession.repositoryId, null);
    assert.equal(result.logicalSession.activeBinding.boundCwd, fixture.workspace);
    assert.equal(result.transition.targetWorktreeId, null);
    assert.equal(result.transition.targetCwd, fixture.workspace);
  } finally {
    await fixture.close();
  }
});

test("invalid fork instruction sources preserve the original route and retain an invalid child binding", async () => {
  const fixture = await createFixture("invalid");
  const dynamicTools = [{ name: "corptie_tool_call" }];
  const sourceProof = toolProof("thread-source", dynamicTools, "thread-start");
  const childProof = toolProof("thread-invalid", dynamicTools, "thread-fork-inherited");
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
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
    confirmToolSchema: async () => childProof,
    requiredInstructionSources: async () => [fixture.featureInstructions]
  });

  try {
    await assert.rejects(
      () => manager.switchWorkspace({
        transitionId: "transition:invalid",
        logicalSessionId: "logical:one",
        targetWorktreeId: "worktree:feature",
        lastCompletedTurnId: "turn-7",
        dynamicTools,
        dynamicToolConfirmation: sourceProof
      }),
      /invalid workspace instruction sources/
    );
    const logical = fixture.store.getLogicalSession("logical:one");
    assert.equal(logical.activeThreadId, "thread-source");
    assert.equal(logical.activeWorkspaceId, "worktree:main");
    assert.equal(logical.routingVersion, 1);
    assert.equal(logical.transitionState, null);
    const failed = fixture.store.getWorkspaceTransition("transition:invalid");
    assert.equal(failed.phase, "failed");
    assert.deepEqual(failed.toolConfirmation, childProof);
    assert.equal(fixture.store.getProviderThreadBinding("thread-invalid").state, "invalid");
  } finally {
    await fixture.close();
  }
});

test("a source-thread deletion failure does not roll back the committed workspace route", async () => {
  const fixture = await createFixture("delete-failure");
  const events = [];
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async forkThread() {
        return {
          thread: { id: "thread-feature", cwd: fixture.feature },
          cwd: fixture.feature,
          runtimeWorkspaceRoots: [fixture.feature],
          instructionSources: [fixture.rootInstructions, fixture.featureInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.feature] }
        };
      },
      async deleteThread() {
        throw new Error("delete unavailable");
      }
    },
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.featureInstructions
    ],
    onRouteCommitted: async (event) => events.push(event)
  });

  try {
    const result = await manager.switchWorkspace({
      transitionId: "transition:delete-failure",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:feature",
      lastCompletedTurnId: "turn-7"
    });

    assert.equal(result.status, "committed");
    assert.equal(result.logicalSession.activeThreadId, "thread-feature");
    assert.equal(result.transition.phase, "committed");
    assert.equal(events[0].sourceThreadDeleted, false);
    assert.equal(events[0].sourceThreadDeletionError, "delete unavailable");
  } finally {
    await fixture.close();
  }
});

test("a missing source Session falls back to a new thread with a bounded local handoff", async () => {
  const fixture = await createFixture("handoff-fallback");
  const calls = [];
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async forkThread() {
        const error = new Error("The source Provider Session no longer exists.");
        error.code = "PROVIDER_SESSION_UNAVAILABLE";
        throw error;
      },
      async startThread(options) {
        calls.push({ method: "startThread", options });
        return {
          thread: { id: "thread-handoff", cwd: fixture.feature },
          cwd: fixture.feature,
          runtimeWorkspaceRoots: [fixture.feature],
          instructionSources: [fixture.rootInstructions, fixture.featureInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.feature] }
        };
      },
      async startTurn(threadId, prompt, options) {
        calls.push({ method: "startTurn", threadId, prompt, options });
        return { turn: { id: "turn-handoff" } };
      }
    },
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.featureInstructions
    ],
    sourceTimelineItems: async () => [
      { type: "userMessage", presentationText: "Finish the workspace migration.", turnId: "turn-7" },
      { type: "agentMessage", presentationText: "The registry is complete.", turnId: "turn-7", presentationRole: "final_answer" }
    ]
  });

  try {
    const result = await manager.switchWorkspace({
      transitionId: "transition:handoff-fallback",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:feature",
      lastCompletedTurnId: "turn-7"
    });
    assert.equal(result.status, "committed");
    assert.equal(result.transition.strategy, "handoff");
    assert.equal(result.logicalSession.activeThreadId, "thread-handoff");
    assert.equal(result.event.handoffTurnId, "turn-handoff");
    assert.deepEqual(calls.map((call) => call.method), ["startThread", "startTurn"]);
    assert.equal(calls[0].options.cwd, fixture.feature);
    assert.match(calls[1].prompt, /host-generated local handoff/);
    assert.match(calls[1].prompt, /Finish the workspace migration/);
    assert.match(calls[1].prompt, /The registry is complete/);
  } finally {
    await fixture.close();
  }
});

test("an incorrect source Tool proof fails before native fork and uses a confirmed handoff", async () => {
  const fixture = await createFixture("tool-proof-handoff");
  const dynamicTools = [{ name: "corptie_tool_call", inputSchema: { type: "object" } }];
  const calls = [];
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async forkThread() {
        assert.fail("an invalid Tool proof must fail before Provider fork mutation");
      },
      async startThread(options) {
        calls.push({ method: "startThread", options });
        return {
          thread: { id: "thread-tool-handoff", cwd: fixture.feature },
          cwd: fixture.feature,
          instructionSources: [fixture.rootInstructions, fixture.featureInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.feature] }
        };
      },
      async startTurn() {
        calls.push({ method: "startTurn" });
        return { turn: { id: "turn-tool-handoff" } };
      }
    },
    confirmToolSchema: async ({ threadId }) => (
      toolProof(threadId, dynamicTools, "thread-start")
    ),
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.featureInstructions
    ]
  });

  try {
    const result = await manager.switchWorkspace({
      transitionId: "transition:tool-proof-handoff",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:feature",
      lastCompletedTurnId: "turn-7",
      dynamicTools,
      dynamicToolConfirmation: {
        providerRevision: "thread-start:thread-source:stale",
        providerDefinitionsHash: toolProof(
          "thread-source",
          dynamicTools,
          "thread-start"
        ).providerDefinitionsHash
      },
      dynamicToolMetadata: {
        sessionId: "session:one",
        providerBindingId: "binding:source"
      }
    });
    assert.equal(result.status, "committed");
    assert.equal(result.event.strategy, "handoff");
    assert.deepEqual(calls.map((call) => call.method), ["startThread", "startTurn"]);
    assert.deepEqual(calls[0].options.dynamicTools, dynamicTools);
    assert.notEqual(calls[0].options.dynamicToolMetadata.providerBindingId, "binding:source");
    assert.equal(calls[0].options.dynamicToolMetadata.providerBindingId,
      result.logicalSession.activeBinding.bindingId);
  } finally {
    await fixture.close();
  }
});

test("a cross-repository switch uses handoff without attempting a fork", async () => {
  const fixture = await createFixture("cross-repository");
  const other = join(fixture.directory, "other repository");
  await mkdir(other);
  const otherInstructions = join(other, "AGENTS.md");
  await writeFile(otherInstructions, "other");
  fixture.store.upsertGitWorkspaceSnapshot({
    repository: {
      id: "repository:two",
      commonGitDirCanonicalPath: join(other, ".git"),
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:00:00.000Z"
    },
    inventoryVersion: "inventory:two",
    observedAt: "2026-07-28T00:00:00.000Z",
    worktrees: [
      workspaceRecord("worktree:other", other, join(other, ".git"), true, "main")
    ]
  });
  let forked = false;
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async forkThread() {
        forked = true;
        assert.fail("cross-repository switching must not fork");
      },
      async startThread() {
        return {
          thread: { id: "thread-other", cwd: other },
          cwd: other,
          runtimeWorkspaceRoots: [other],
          instructionSources: [otherInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [other] }
        };
      },
      async startTurn() {
        return { turn: { id: "turn-other-handoff" } };
      }
    },
    requiredInstructionSources: async () => [otherInstructions]
  });

  try {
    const result = await manager.switchWorkspace({
      transitionId: "transition:cross-repository",
      logicalSessionId: "logical:one",
      targetWorktreeId: "worktree:other",
      lastCompletedTurnId: "turn-7"
    });
    assert.equal(forked, false);
    assert.equal(result.transition.strategy, "handoff");
    assert.equal(result.logicalSession.repositoryId, "repository:two");
    assert.equal(result.logicalSession.activeWorkspaceId, "worktree:other");
  } finally {
    await fixture.close();
  }
});

test("fork fallback detection and handoff prompt are conservative", () => {
  assert.equal(isForkUnsupported(Object.assign(new Error("missing"), { code: -32601 })), true);
  assert.equal(isForkUnsupported(Object.assign(new Error("source missing"), {
    code: "PROVIDER_SESSION_UNAVAILABLE"
  })), true);
  assert.equal(isForkUnsupported(Object.assign(new Error("schema inherited"), {
    code: "PROVIDER_TOOL_SCHEMA_FORK_UNSUPPORTED"
  })), true);
  assert.equal(isForkUnsupported(new Error("thread/fork unsupported by server")), true);
  assert.equal(isForkUnsupported(new Error("thread/fork timed out")), false);
  const prompt = workspaceHandoffPrompt([
    { type: "userMessage", presentationText: "Keep going", turnId: "turn-1" }
  ], {
    sourceCwd: "/old",
    targetCwd: "/new",
    lastCompletedTurnId: "turn-1"
  });
  assert.match(prompt, /not a new user instruction/);
  assert.match(prompt, /Keep going/);
});

test("a moved worktree path is rebound in place with updated sandbox roots and instructions", async () => {
  const fixture = await createFixture("settings-update");
  const moved = join(fixture.directory, "moved main worktree");
  await mkdir(moved);
  const movedInstructions = join(moved, "AGENTS.md");
  await writeFile(movedInstructions, "moved");
  fixture.store.upsertGitWorkspaceSnapshot({
    repository: {
      id: "repository:one",
      commonGitDirCanonicalPath: join(fixture.directory, ".git"),
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:02:00.000Z"
    },
    inventoryVersion: "inventory:moved",
    observedAt: "2026-07-28T00:02:00.000Z",
    worktrees: [
      workspaceRecord("worktree:main", moved, join(fixture.directory, ".git"), true, "main"),
      workspaceRecord(
        "worktree:feature",
        fixture.feature,
        join(fixture.directory, ".git", "worktrees", "feature"),
        false,
        "feature/workspace"
      )
    ]
  });
  const calls = [];
  const events = [];
  const dynamicTools = [{ name: "corptie_tool_catalog_load" }];
  const toolConfirmation = toolProof("thread-source", dynamicTools, "thread-start");
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async updateThreadSettings(threadId, options) {
        calls.push({ method: "settings", threadId, options });
        return {};
      },
      async resumeThread(threadId, options) {
        calls.push({ method: "resume", threadId, options });
        return {
          thread: { id: threadId, cwd: moved },
          cwd: moved,
          runtimeWorkspaceRoots: [moved],
          instructionSources: [fixture.rootInstructions, movedInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [moved] }
        };
      }
    },
    confirmToolSchema: async ({ threadId }) => {
      assert.equal(threadId, "thread-source");
      return toolConfirmation;
    },
    requiredInstructionSources: async () => [fixture.rootInstructions, movedInstructions],
    onRouteCommitted: async (event) => events.push(event)
  });

  try {
    const result = await manager.reconcileActiveWorkspacePath("logical:one", {
      dynamicTools,
      dynamicToolConfirmation: toolConfirmation,
      dynamicToolAgentId: "agent:one",
      dynamicToolMetadata: { sessionId: "session:one" }
    });
    assert.equal(result.status, "rebound");
    assert.equal(result.logicalSession.activeThreadId, "thread-source");
    assert.equal(result.logicalSession.activeBinding.boundCwd, moved);
    assert.equal(result.logicalSession.routingVersion, 2);
    assert.equal(calls[0].method, "settings");
    assert.deepEqual(calls[0].options.sandboxPolicy.writableRoots, [moved]);
    assert.equal(calls[1].method, "resume");
    assert.deepEqual(calls[1].options.runtimeWorkspaceRoots, [moved]);
    assert.deepEqual(calls[1].options.dynamicTools, dynamicTools);
    assert.deepEqual(calls[1].options.dynamicToolConfirmation, toolConfirmation);
    assert.deepEqual(calls[1].options.dynamicToolMetadata, { sessionId: "session:one" });
    assert.equal(events[0].strategy, "settingsUpdate");
    assert.equal(events[0].toolConfirmation.providerDefinitionsHash, toolConfirmation.providerDefinitionsHash);
    assert.equal(events[0].previousCwd, fixture.main);
  } finally {
    await fixture.close();
  }
});

test("workspace path rewriting changes only the moved workspace prefix", () => {
  assert.deepEqual(rewriteWorkspacePath({
    writableRoots: ["/old/worktree", "/old/worktree/generated", "/other"],
    nested: { cwd: "/old/worktree" }
  }, "/old/worktree", "/new/worktree"), {
    writableRoots: ["/new/worktree", "/new/worktree/generated", "/other"],
    nested: { cwd: "/new/worktree" }
  });
});

test("restart recovery defers Provider-native goal continuation to Corptie's durable queue", async () => {
  const fixture = await createFixture("recover-waiting-goal");
  const bindingId = fixture.store.getLogicalSession("logical:one").activeBinding.bindingId;
  fixture.store.upsertSessionTurn({
    sessionId: "session:one",
    bindingId,
    routingVersion: 1,
    turnId: "turn-7",
    executionStatus: "completed",
    endedAt: "2026-07-28T00:01:00.000Z"
  });
  fixture.store.beginWorkspaceTransition({
    transitionId: "transition:recover-waiting-goal",
    logicalSessionId: "logical:one",
    targetWorktreeId: "worktree:feature",
    sourceRoutingVersion: 1,
    lastCompletedTurnId: "turn-6",
    resumeGoalAfterTransition: true,
    phase: "waitingForTurn"
  });
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async forkThread(threadId, options) {
        assert.equal(threadId, "thread-source");
        assert.equal(options.lastTurnId, "turn-7");
        assert.equal(options.deferGoalContinuation, true);
        return {
          thread: { id: "thread-recovered-goal", cwd: fixture.feature },
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
    const result = await manager.recoverWorkspaceTransition("transition:recover-waiting-goal");
    assert.equal(result.status, "committed");
    assert.equal(result.transition.resumeGoalAfterTransition, true);
    assert.equal(result.logicalSession.activeThreadId, "thread-recovered-goal");
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
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
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

test("backend restart recovers a native fork only with its persisted child Tool proof", async () => {
  const fixture = await createFixture("recover-tool-proof");
  const dynamicTools = [{ name: "corptie_tool_catalog_search" }];
  const childProof = toolProof("thread-recovered-tools", dynamicTools, "thread-fork-inherited");
  fixture.store.beginWorkspaceTransition({
    transitionId: "transition:recover-tool-proof",
    logicalSessionId: "logical:one",
    targetWorktreeId: "worktree:feature",
    sourceRoutingVersion: 1,
    lastCompletedTurnId: "turn-7",
    phase: "forking"
  });
  fixture.store.updateWorkspaceTransition("transition:recover-tool-proof", {
    phase: "validatingInstructions",
    newThreadId: "thread-recovered-tools"
  });
  const getWorkspaceTransition = fixture.store.getWorkspaceTransition.bind(fixture.store);
  fixture.store.getWorkspaceTransition = (transitionId) => {
    const transition = getWorkspaceTransition(transitionId);
    return transitionId === "transition:recover-tool-proof" && transition
      ? { ...transition, toolConfirmation: childProof }
      : transition;
  };
  const calls = [];
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async resumeThread(threadId, options) {
        calls.push({ threadId, options });
        return {
          thread: { id: threadId, cwd: fixture.feature },
          cwd: fixture.feature,
          instructionSources: [fixture.rootInstructions, fixture.featureInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.feature] }
        };
      }
    },
    confirmToolSchema: async ({ threadId }) => {
      assert.equal(threadId, "thread-recovered-tools");
      return childProof;
    },
    prepareToolMaterialization: async (input) => {
      assert.equal(input.recovered, true);
      assert.equal(input.binding.providerThreadId, "thread-recovered-tools");
      assert.equal(input.dynamicToolMetadata.sessionId, "session:one");
      return null;
    },
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.featureInstructions
    ]
  });

  try {
    const result = await manager.recoverWorkspaceTransition("transition:recover-tool-proof", {
      dynamicTools,
      dynamicToolAgentId: "agent:one",
      dynamicToolMetadata: { sessionId: "session:one" },
      // A caller proof is deliberately stale: the persisted child proof is authoritative.
      dynamicToolConfirmation: toolProof("thread-source", dynamicTools, "thread-start")
    });
    assert.equal(result.status, "committed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.dynamicTools, dynamicTools);
    assert.equal(calls[0].options.dynamicToolConfirmation.providerRevision, childProof.providerRevision);
    assert.equal(calls[0].options.dynamicToolAgentId, "agent:one");
    assert.equal(calls[0].options.dynamicToolMetadata.sessionId, "session:one");
    assert.equal(calls[0].options.dynamicToolMetadata.providerBindingId,
      result.logicalSession.activeBinding.bindingId);
    assert.equal(calls[0].options.dynamicToolMetadata.routingVersion, 2);
    assert.equal(calls[0].options.dynamicToolMetadata.bindingGeneration, 2);
    assert.equal(result.event.newBindingId, result.logicalSession.activeBinding.bindingId);
  } finally {
    await fixture.close();
  }
});

test("crash recovery rejects dynamic Tools when the child proof was not durably journaled", async () => {
  const fixture = await createFixture("recover-tool-proof-missing");
  fixture.store.beginWorkspaceTransition({
    transitionId: "transition:recover-tool-proof-missing",
    logicalSessionId: "logical:one",
    targetWorktreeId: "worktree:feature",
    sourceRoutingVersion: 1,
    lastCompletedTurnId: "turn-7",
    phase: "forking"
  });
  fixture.store.updateWorkspaceTransition("transition:recover-tool-proof-missing", {
    phase: "validatingInstructions",
    newThreadId: "thread-unproven"
  });
  let resumes = 0;
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async resumeThread() {
        resumes += 1;
        assert.fail("recovery must reject the missing proof before Provider resume");
      }
    }
  });

  try {
    await assert.rejects(() => manager.recoverWorkspaceTransition(
      "transition:recover-tool-proof-missing",
      { dynamicTools: [{ name: "corptie_tool_call" }] }
    ), { code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED" });
    assert.equal(resumes, 0);
    assert.equal(fixture.store.getWorkspaceTransition("transition:recover-tool-proof-missing").phase, "failed");
  } finally {
    await fixture.close();
  }
});

test("restart recovery starts a missing handoff turn before committing its route", async () => {
  const fixture = await createFixture("recover-handoff");
  fixture.store.beginWorkspaceTransition({
    transitionId: "transition:recover-handoff",
    logicalSessionId: "logical:one",
    targetWorktreeId: "worktree:feature",
    sourceRoutingVersion: 1,
    lastCompletedTurnId: "turn-7",
    strategy: "handoff",
    phase: "forking"
  });
  fixture.store.updateWorkspaceTransition("transition:recover-handoff", {
    phase: "validatingInstructions",
    newThreadId: "thread-handoff-recovered"
  });
  const startedTurns = [];
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {
      async resumeThread() {
        return {
          thread: { id: "thread-handoff-recovered", cwd: fixture.feature },
          cwd: fixture.feature,
          instructionSources: [fixture.rootInstructions, fixture.featureInstructions],
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [fixture.feature] }
        };
      },
      async startTurn(threadId, prompt) {
        startedTurns.push({ threadId, prompt });
        return { turn: { id: "turn-recovered-handoff" } };
      }
    },
    requiredInstructionSources: async () => [
      fixture.rootInstructions,
      fixture.featureInstructions
    ],
    sourceTimelineItems: async () => [
      { type: "userMessage", presentationText: "Resume me", turnId: "turn-7" }
    ]
  });

  try {
    const result = await manager.recoverWorkspaceTransition("transition:recover-handoff");
    assert.equal(result.status, "committed");
    assert.equal(result.event.strategy, "handoff");
    assert.equal(result.event.handoffTurnId, "turn-recovered-handoff");
    assert.equal(startedTurns.length, 1);
    assert.match(startedTurns[0].prompt, /Resume me/);
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
  const manager = new ForkingWorkspaceTransitionManager({
    store: fixture.store,
    providerPort: {}
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
  store.upsertSession({
    id: "session:one",
    title: "Fixture session",
    agent: "Agent",
    provider: "test-provider",
    status: "idle"
  });
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
    legacySessionId: "session:one",
    providerThreadId: "thread-source",
    providerId: "test-provider",
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

async function createDirectoryFixture(label) {
  const directory = await mkdtemp(join(tmpdir(), `corptie-transition-${label}-`));
  const workspace = join(directory, "regular directory");
  await mkdir(workspace);
  const instructions = join(workspace, "AGENTS.md");
  await writeFile(instructions, "directory instructions");
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  store.createLogicalSessionRoute({
    logicalSessionId: "logical:directory",
    providerThreadId: "thread-source",
    providerId: "test-provider",
    boundCwd: workspace,
    instructionSources: [instructions],
    permissionSnapshot: {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace] }
    }
  });
  return {
    directory,
    workspace,
    instructions,
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

function toolProof(threadId, definitions, kind) {
  const providerObservationKind = kind === "thread-start"
    ? "thread_start_accepted"
    : "thread_fork_inherited";
  return {
    providerRevision: kind === "thread-start"
      ? `thread-start:${threadId}:confirmed`
      : `thread-fork-inherited:${threadId}:thread-source:confirmed`,
    providerDefinitionsHash: createHash("sha256")
      .update(stableToolDefinitions(definitions))
      .digest("hex"),
    providerContractHash: toolDefinitionsContractHash(definitions),
    providerDefinitionsCount: definitions.length,
    providerObservationKind
  };
}

function stableToolDefinitions(value) {
  if (Array.isArray(value)) return `[${value.map(stableToolDefinitions).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableToolDefinitions(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
