import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionWorkspaceHttpRequest } from "../src/application/sessionWorkspaceHttpApi.mjs";

function fixture() {
  const calls = [];
  const events = [];
  const logical = { logicalSessionId: "logical", repositoryId: "repo", activeWorkspaceId: "tree", activeBinding: { boundCwd: "/fixture" } };
  const reference = { sessionId: "stored", logicalSessionId: "logical", providerId: "test", metadata: { session: { id: "stored" } } };
  const record = (name, result) => async (...args) => { calls.push([name, ...args]); return result; };
  const dependencies = {
    store: {
      getLogicalSession: () => logical,
      getLogicalSessionByLegacySessionId: () => logical,
      upsertGitWorkspaceSnapshot: (snapshot) => calls.push(["snapshot", snapshot]),
      listGitWorktrees: () => [{ worktreeId: "tree" }],
      listProviderThreadBindings: () => [{ bindingId: "old", state: "retired", worktreeId: "tree" }],
      getGitWorktree: () => ({ repositoryId: "repo", branchName: "feature" }),
      getAgentSessionBinding: () => ({ logicalSessionId: "other" }),
      getSession: () => ({ id: "stored" }),
      getItemsForBinding: () => { calls.push(["items"]); return []; }
    },
    sessionApplicationService: { referenceFor: async () => reference },
    requireSessionReference: () => reference,
    ensureLogicalRouteForProviderSession: async () => logical,
    createGitWorkspaceSnapshot: record("inspect", { worktrees: [] }),
    reconcileMovedWorkspaceRoutes: record("reconcile"),
    sessionWorkspaceRecoveryStatus: async () => ({ orphaned: true, worktrees: [{ worktreeId: "target" }], canRebuild: true, recoveryKind: "agentWorkspace" }),
    switchSessionWorkspace: record("switch", { status: "waitingForTurn" }),
    recoverableAgentWorkDir: () => "/fixture",
    ensureAgentWorkDir: record("ensure", "/fixture"),
    gitWorkspaces: { restoreMissingWorktree: record("restore", { restored: { worktreeId: "new-tree" } }) },
    switchSessionProvider: record("provider", { status: "waitingForTurn" }),
    decorateSessionForClient: (session) => ({ ...session, decorated: true }),
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    emitEvent: (...args) => events.push(args),
    errorStatus: (error, fallback) => error.statusCode ?? fallback,
    unifiedErrorStatus: () => 400
  };
  function dispatch(path, method = "GET", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const handled = handleSessionWorkspaceHttpRequest({ ...dependencies,
      request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") });
    return { handled, result };
  }
  return { calls, events, logical, dependencies, dispatch };
}

test("workspace inventory refresh precedes projection and retired bindings remain read-only", async () => {
  const f = fixture();
  const result = await f.dispatch("/sessions/public/workspaces").result;
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.map(([name]) => name), ["inspect", "snapshot", "reconcile"]);
  assert.equal(result.body.history[0].readOnly, true);
  assert.equal(result.body.history[0].branchName, "feature");
});

test("binding snapshot checks Session ownership before reading items", async () => {
  const f = fixture();
  const result = await f.dispatch("/sessions/public/bindings/other/snapshot").result;
  assert.equal(result.body.code, "SESSION_BINDING_NOT_FOUND");
  assert.deepEqual(f.calls, []);
});

test("workspace recovery rejects available workspaces and unlisted switch targets", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/sessions/public/workspace/recovery", "POST", { action: "switch", targetWorktreeId: "foreign" }).result).status, 400);
  assert.deepEqual(f.calls, []);
  f.dependencies.sessionWorkspaceRecoveryStatus = async () => ({ orphaned: false });
  assert.equal((await f.dispatch("/sessions/public/workspace/recovery", "POST", { action: "rebuild" }).result).status, 400);
  assert.deepEqual(f.calls, []);
});

test("rebuilding a Git worktree transitions before publishing success", async () => {
  const f = fixture();
  const result = await f.dispatch("/sessions/public/workspace/recovery", "POST", { action: "rebuild" }).result;
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls, [["restore", { logicalSessionId: "logical" }], ["switch", "public", "new-tree"]]);
  assert.equal(f.events[0][0], "SessionWorkspaceRebuilt");
  assert.deepEqual(result.body.transition, { status: "waitingForTurn" });
});

test("non-Git workspace rebuild requires both recovery permission and recoverable ownership", async () => {
  const f = fixture();
  f.logical.repositoryId = null;
  f.dependencies.store.getAgent = () => ({ id: "agent" });
  f.dependencies.recoverableAgentWorkDir = () => null;
  assert.equal((await f.dispatch("/sessions/public/workspace/recovery", "POST", { action: "rebuild" }).result).status, 400);
  assert.deepEqual(f.calls, []);
  f.dependencies.recoverableAgentWorkDir = () => "/fixture";
  assert.equal((await f.dispatch("/sessions/public/workspace/recovery", "POST", { action: "rebuild" }).result).status, 200);
  assert.equal(f.calls[0][0], "ensure");
});

test("switch aliases retain request fields, waiting status and stale route diagnostics", async () => {
  const f = fixture();
  for (const path of ["workspace/switch", "actions/switch-workspace"]) {
    assert.equal((await f.dispatch(`/sessions/public%2Fid/${path}`, "POST", { targetWorkspaceId: "target", targetWorktreeId: "old", transitionId: "transition", continuationPrompt: "continue" }).result).status, 202);
    assert.deepEqual(f.calls.at(-1), ["switch", "public/id", "target", "transition", "continue"]);
  }
  for (const path of ["switch-provider", "actions/switch-provider"]) {
    assert.equal((await f.dispatch(`/sessions/public/${path}`, "POST", { providerId: "test", transitionId: "transition", expectedRoutingVersion: 3 }).result).status, 202);
    assert.deepEqual(f.calls.at(-1), ["provider", "public", "test", "transition", 3]);
  }
  f.dependencies.switchSessionProvider = async () => { throw Object.assign(new Error("stale"), { code: "STALE_SESSION_ROUTE", statusCode: 409, expectedRoutingVersion: 3, currentRoutingVersion: 4 }); };
  const stale = await f.dispatch("/sessions/public/switch-provider", "POST").result;
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentRoutingVersion, 4);
  assert.deepEqual(stale.body.session, { id: "stored", decorated: true });
  assert.equal(f.dispatch("/other").handled, false);
});
