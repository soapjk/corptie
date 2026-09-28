import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionGitHttpRequest } from "../src/application/sessionGitHttpApi.mjs";
import { handleSessionToolsetHttpRequest } from "../src/application/sessionToolsetHttpApi.mjs";

function fixture() {
  const calls = [];
  const record = (name, value = { ok: true }) => async (...args) => { calls.push([name, ...args]); return value; };
  const dependencies = Object.fromEntries([
    "prepareGitHubPush", "generateGitHubPushCommitMessage", "confirmGitHubPush", "projectWorktreeStatus",
    "mergeProjectWorktree", "prepareProjectWorktreeCommit", "generateProjectWorktreeCommitMessage",
    "commitProjectWorktree", "completeProjectWorktree", "operateProjectWorktree", "restartProjectWorktree"
  ].map((name) => [name, record(name)]));
  Object.assign(dependencies, {
    projectToolsetStatus: record("status", { ready: true }),
    projectWorkingDirectoryForSession: () => "/fixture",
    projectToolsetAuthenticatedSession: () => ({ sessionId: "authorized" }),
    projectToolsetInitializer: { schedule: record("schedule"), cancel: record("cancel") },
    projectToolsets: { selectProfile: record("profile"), run: record("run") },
    projectToolsetRunIsolationOptions: record("isolation", { sourceIdentity: "source" }),
    emitEvent: (...args) => calls.push(["event", ...args]),
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error, fallback) => error.statusCode ?? fallback
  });
  function dispatch(path, method = "POST", body = { marker: true }) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const context = { ...dependencies, request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") };
    const handled = handleSessionGitHttpRequest(context) || handleSessionToolsetHttpRequest(context);
    return { handled, result };
  }
  return { calls, dependencies, dispatch };
}

for (const [action, operation, receivesInput] of [
  ["prepare", "prepareGitHubPush", false], ["commit-message", "generateGitHubPushCommitMessage", true], ["confirm", "confirmGitHubPush", true]
]) {
  test(`GitHub ${action} dispatches only its requested operation`, async () => {
    const f = fixture();
    assert.equal((await f.dispatch(`/sessions/public%2Fid/github-push/${action}`).result).status, 200);
    assert.deepEqual(f.calls, [[operation, "public/id", ...(receivesInput ? [{ marker: true }] : [])]]);
  });
}

for (const [action, operation, receivesInput] of [
  ["merge", "mergeProjectWorktree", true], ["complete", "completeProjectWorktree", true],
  ["restart", "restartProjectWorktree", false], ["operate", "operateProjectWorktree", true],
  ["commit", "commitProjectWorktree", true], ["commit-prepare", "prepareProjectWorktreeCommit", false],
  ["commit-message", "generateProjectWorktreeCommitMessage", false]
]) {
  test(`Worktree ${action} retains argument and status contract`, async () => {
    const f = fixture();
    assert.equal((await f.dispatch(`/sessions/public/project-worktrees/tree%2Fid/${action}`).result).status, 200);
    assert.deepEqual(f.calls, [[operation, "public", "tree/id", ...(receivesInput ? [{ marker: true }] : [])]]);
  });
}

test("toolset initialization responds before background work finishes and keeps authority", async () => {
  const f = fixture();
  f.dependencies.projectToolsetInitializer.schedule = (...args) => { f.calls.push(["schedule", ...args]); return new Promise(() => {}); };
  for (const action of ["initialize", "update"]) {
    assert.deepEqual(await f.dispatch(`/sessions/public/project-toolset/${action}`, "POST", { idempotencyKey: "key" }).result,
      { status: 202, body: { scheduled: true, action } });
    assert.deepEqual(f.calls.at(-1), ["schedule", "/fixture", { force: action === "update", authenticatedSession: { sessionId: "authorized" }, idempotencyKey: "key" }]);
  }
});

test("toolset execution keeps isolation authority and start/restart timeout", async () => {
  for (const action of ["start", "restart", "stop"]) {
    const f = fixture();
    assert.equal((await f.dispatch(`/sessions/public/project-toolset/${action}`).result).status, 200);
    assert.deepEqual(f.calls[0], ["isolation", "public", "/fixture", action]);
    assert.deepEqual(f.calls[1], ["run", "/fixture", action, {
      runIsolation: { sourceIdentity: "source" }, sourceIdentity: "source",
      ...(action === "stop" ? {} : { timeoutMs: 60000 })
    }]);
    assert.equal(f.calls.at(-1)[1], "ProjectServiceChanged");
  }
  const f = fixture();
  f.dependencies.projectToolsetRunIsolationOptions = async () => { throw new Error("isolation denied"); };
  assert.equal((await f.dispatch("/sessions/public/project-toolset/start").result).status, 400);
  assert.deepEqual(f.calls, []);
});

test("cancel and profile require identifiers; read-only routes and fallthrough are preserved", async () => {
  const f = fixture();
  for (const action of ["cancel", "profile"]) {
    assert.equal((await f.dispatch(`/sessions/public/project-toolset/${action}`, "POST", {}).result).status, 400);
  }
  assert.deepEqual(f.calls, []);
  await f.dispatch("/sessions/public/project-toolset/cancel", "POST", { operationId: " op " }).result;
  assert.deepEqual(f.calls[0], ["cancel", "op"]);
  await f.dispatch("/sessions/public/project-toolset/profile", "POST", { profileId: " profile " }).result;
  assert.deepEqual(f.calls[1], ["profile", "/fixture", "profile"]);
  assert.equal((await f.dispatch("/sessions/public/project-toolset", "GET").result).status, 200);
  assert.equal((await f.dispatch("/sessions/public/project-worktrees", "GET").result).status, 200);
  assert.equal(f.dispatch("/sessions/public/project-toolset/start", "GET").handled, false);
  assert.equal(f.dispatch("/other").handled, false);
});
