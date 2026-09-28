import assert from "node:assert/strict";
import test from "node:test";
import { createPostTurnWorkspaceOperations } from "../src/application/postTurnWorkspaceOperations.mjs";

function fixture() {
  const calls = [];
  const transition = { transitionId: "transition", phase: "waitingForTurn", transitionKind: "workspace" };
  const coordinator = { enqueueForTransition: (id) => { calls.push(["enqueue", id]); return id; } };
  const operations = createPostTurnWorkspaceOperations({
    store: { getPendingWorkspaceTransition: () => transition },
    workspaceTransitionRuntimeForLogicalSession: async () => ({
      manager: { continueWorkspaceTransition: async (...args) => calls.push(["workspace", ...args]) },
      options: { executionRoot: "/workspace" }
    }),
    sessionBindingRepository: { resolve: (id) => ({ sessionId: id }) },
    sessionProviderSwitchCoordinator: {
      completeProviderSwitch: async (...args) => calls.push(["provider", ...args])
    },
    workspaceContinuationCoordinator: coordinator,
    createGitWorkspaceSnapshot: async () => ({}),
    emitEvent: (...args) => calls.push(["event", ...args])
  });
  return { operations, calls, transition, coordinator, logical: { logicalSessionId: "logical", legacySessionId: "session" } };
}

test("workspace transition resumes only the workspace path with its completed-turn checkpoint", async () => {
  const f = fixture();
  assert.equal(f.operations.continuePendingProviderSwitch(f.logical), null);
  await f.operations.continuePendingWorkspaceTransition(f.logical, "turn");
  assert.deepEqual(f.calls, [["workspace", "transition", { lastCompletedTurnId: "turn", executionRoot: "/workspace" }]]);
});

test("provider transition resolves the current session reference without running workspace continuation", async () => {
  const f = fixture();
  f.transition.transitionKind = "provider";
  assert.equal(f.operations.continuePendingWorkspaceTransition(f.logical, "turn"), null);
  await f.operations.continuePendingProviderSwitch(f.logical);
  assert.deepEqual(f.calls[0], ["provider", "transition", undefined, { sessionId: "session" }, f.logical]);
});

test("continuation enqueue failures publish a deferred event instead of escaping", () => {
  const f = fixture();
  f.coordinator.enqueueForTransition = () => { throw new Error("busy"); };
  assert.equal(f.operations.enqueueWorkspaceContinuationSafely("transition"), null);
  assert.equal(f.calls[0][1], "WorkspaceContinuationDeferred");
  assert.equal(f.calls[0][2].error, "busy");
});

function pathFixture() {
  const events = [];
  const session = { id: "session", status: "idle" };
  const logical = {
    logicalSessionId: "logical", legacySessionId: session.id,
    activeBinding: { boundCwd: "/old" }, activeWorkspaceId: "workspace"
  };
  let unsettled = [];
  let complete;
  let calls = 0;
  const operations = createPostTurnWorkspaceOperations({
    store: {
      listLogicalSessionsByWorkspaceId: () => [logical],
      getSession: () => session,
      listUnsettledSessionTurns: () => unsettled
    },
    workspaceTransitionRuntimeForLogicalSession: async () => ({
      manager: { reconcileActiveWorkspacePath: () => {
        calls += 1;
        return new Promise((resolve) => { complete = resolve; });
      } },
      options: {}
    }),
    emitEvent: (...args) => events.push(args)
  });
  return {
    operations, events, session, logical,
    worktrees: [{ worktreeId: "workspace", availability: "available", canonicalPath: "/new" }],
    callCount: () => calls, finish: () => complete(),
    setUnsettled: (value) => { unsettled = value; }
  };
}

test("busy or journaled unsettled sessions are not rebound", async () => {
  const f = pathFixture();
  f.session.status = "running";
  await f.operations.reconcileMovedWorkspaceRoutes(f.worktrees);
  assert.equal(f.events[0][0], "SessionWorkspacePathRebindDeferred");
  assert.equal(f.callCount(), 0);
  f.session.status = "idle";
  f.setUnsettled([{ turn_id: "turn" }]);
  await f.operations.reconcileMovedWorkspaceRoutes(f.worktrees, { verifyProviderIdle: true });
  assert.equal(f.callCount(), 0);
});

test("overlapping inventory refreshes share the in-flight route guard", async () => {
  const f = pathFixture();
  const first = f.operations.reconcileMovedWorkspaceRoutes(f.worktrees);
  await new Promise((resolve) => setImmediate(resolve));
  await f.operations.reconcileMovedWorkspaceRoutes(f.worktrees);
  assert.equal(f.callCount(), 1);
  f.finish();
  await first;
  const next = f.operations.reconcileMovedWorkspaceRoutes(f.worktrees);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.callCount(), 2);
  f.finish();
  await next;
});
