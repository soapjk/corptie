import assert from "node:assert/strict";
import test from "node:test";
import { createStartupRecoveryOperations } from "../src/application/startupRecoveryOperations.mjs";

function fixture(overrides = {}) {
  const logs = [];
  const options = {
    store: {},
    sessionApplicationService: {},
    sessionRecoveryCoordinator: {},
    sessionBindingRepository: {},
    sessionProviderSwitchCoordinator: {},
    workspaceTransitionRuntimeForLogicalSession: async () => { throw new Error("unexpected runtime"); },
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message)
    },
    ...overrides
  };
  return { operations: createStartupRecoveryOperations(options), logs };
}

test("startup resumes only explicit persisted recoveries with at most two concurrent workers", async () => {
  const failed = [], recovered = [];
  let active = 0, maximum = 0;
  const attempts = Array.from({ length: 5 }, (_, index) => ({
    attemptId: "attempt:" + index, logicalSessionId: "logical:" + index,
    providerId: "test", idempotencyKey: "explicit:" + index
  }));
  const f = fixture({
    store: {
      listResumableSessionRecoveryAttempts: () => [
        { attemptId: "legacy", idempotencyKey: "startup-empty-binding-recovery:old" }, ...attempts
      ],
      failSessionRecoveryAttempt: (...args) => failed.push(args)
    },
    sessionRecoveryCoordinator: {
      recover: async (input) => {
        recovered.push(input);
        maximum = Math.max(maximum, ++active);
        await Promise.resolve();
        active -= 1;
        if (input.attemptId === "attempt:1") throw Object.assign(new Error("failure"), { code: "TEST_FAILURE" });
      }
    }
  });
  await f.operations.resumeSessionRecoveryAttemptsAtStartup();
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(failed[0][0], "legacy");
  assert.equal(failed[0][1], "LEGACY_AUTOMATIC_RECOVERY_DISABLED");
  assert.deepEqual(recovered.map((input) => input.attemptId).sort(), attempts.map((input) => input.attemptId));
  assert.ok(recovered.every((input) => input.compressHandoff === true));
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /attempt=attempt:1 code=TEST_FAILURE/);
});

test("Provider switches wait for unsettled turns while workspace transitions use their runtime", async () => {
  const completed = [], workspace = [];
  const f = fixture({
    store: {
      listPendingWorkspaceTransitions: () => [
        { transitionId: "wait", logicalSessionId: "busy", transitionKind: "provider" },
        { transitionId: "switch", logicalSessionId: "ready", transitionKind: "provider" },
        { transitionId: "move", logicalSessionId: "workspace", transitionKind: "workspace" }
      ],
      getLogicalSession: (id) => ({ logicalSessionId: id, legacySessionId: "session:" + id }),
      listUnsettledSessionTurns: (id) => id === "session:busy" ? [{ id: "turn" }] : []
    },
    sessionBindingRepository: { resolve: (id) => ({ sessionId: id }) },
    sessionProviderSwitchCoordinator: {
      completeProviderSwitch: async (...args) => { completed.push(args); return { status: "complete" }; }
    },
    workspaceTransitionRuntimeForLogicalSession: async (logical) => ({
      options: { logicalSessionId: logical.logicalSessionId },
      manager: {
        recoverWorkspaceTransition: async (...args) => { workspace.push(args); return { status: "complete" }; }
      }
    })
  });
  await f.operations.recoverPendingWorkspaceTransitions();
  assert.deepEqual(completed.map((args) => args[0]), ["switch"]);
  assert.equal(completed[0][2].sessionId, "session:ready");
  assert.deepEqual(workspace, [["move", { logicalSessionId: "workspace" }]]);
  assert.match(f.logs[0], /waiting transition=wait unsettled=1/);
});

test("one failed transition does not prevent recovery of the next persisted transition", async () => {
  const recovered = [];
  const f = fixture({
    store: {
      listPendingWorkspaceTransitions: () => [
        { transitionId: "broken", logicalSessionId: "one" },
        { transitionId: "next", logicalSessionId: "two" }
      ],
      getLogicalSession: (id) => ({ logicalSessionId: id })
    },
    workspaceTransitionRuntimeForLogicalSession: async (logical) => {
      if (logical.logicalSessionId === "one") throw new Error("runtime unavailable");
      return { options: {}, manager: {
        recoverWorkspaceTransition: async (id) => { recovered.push(id); return { status: "complete" }; }
      } };
    }
  });
  await f.operations.recoverPendingWorkspaceTransitions();
  assert.deepEqual(recovered, ["next"]);
  assert.match(f.logs[0], /transition=broken error=runtime unavailable/);
});

test("historical cleanup counts local deletions and retains Provider failure diagnostics", async () => {
  const deletions = [];
  const f = fixture({
    store: { listUnusableReplacedTaskSessionIds: () => ["old:1", "old:2"] },
    sessionApplicationService: {
      deleteUnusableSession: async (id, options) => {
        deletions.push({ id, options });
        return { deleted: id === "old:1", providerDeleted: false, providerErrorCode: "UNAVAILABLE" };
      }
    }
  });
  assert.equal(await f.operations.deleteHistoricalUnusableTaskSessionsAtStartup(), 1);
  assert.deepEqual(deletions.map((entry) => entry.id), ["old:1", "old:2"]);
  assert.ok(deletions.every((entry) => entry.options.source === "task-self-repair-startup-cleanup"));
  assert.equal(f.logs.length, 2);
});
