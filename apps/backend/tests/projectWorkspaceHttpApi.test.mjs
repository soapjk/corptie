import assert from "node:assert/strict";
import test from "node:test";
import { handleProjectWorkspaceHttpRequest } from "../src/application/projectWorkspaceHttpApi.mjs";

function fixture() {
  const calls = [];
  const events = [];
  const result = { id: "result" };
  const service = (names, sync = []) => Object.fromEntries(names.split(" ").map((name) => [name,
    (...args) => { calls.push([name, ...args]); return sync.includes(name) ? result : Promise.resolve(result); }
  ]));
  const dependencies = {
    worktreeIntegrationJobService: service("repositories repository worktreeGitHubPushStatus preflight createCandidate startCandidate cleanupMergedWorktrees deleteWorktree get confirm cancel resolveConflictWithAgent retry", ["repositories", "get"]),
    projectWorktreeIntegrationService: service("status integrateCompleted createConflictTask"),
    projectApplicationService: service("listWorkspaces runWorkspaceAction readDevelopmentService runDevelopmentServiceAction readProject")
  };
  function dispatch(path, method = "GET", body = { marker: true }) {
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const handled = handleProjectWorkspaceHttpRequest({ ...dependencies,
      request: { method }, response: { resolve }, url: new URL(path, "http://localhost"),
      readJson: async () => { if (body instanceof Error) throw body; return body; },
      sendJson: (response, status, payload) => response.resolve({ status, body: payload }),
      emitEvent: (...args) => events.push(args),
      errorStatus: (error, fallback) => error.statusCode ?? fallback,
      unifiedErrorStatus: () => 400
    });
    return { handled, response };
  }
  return { calls, events, result, dependencies, dispatch };
}

const input = { marker: true };
const cases = [
  ["/worktree-management/repositories", "GET", ["repositories"], 200, "repositories"],
  ["/worktree-management/repositories/repo%2Fid?forceFresh=true", "GET", ["repository", "repo/id", { forceFresh: true }], 200],
  ["/worktree-management/repositories/repo/worktrees/tree/github-push-status", "GET", ["worktreeGitHubPushStatus", "repo", "tree"], 200],
  ["/worktree-management/repositories/repo/integration-plans", "POST", ["preflight", "repo", input], 201, "job"],
  ["/worktree-management/repositories/repo/integration-candidates", "POST", ["createCandidate", "repo", input], 200, "candidate"],
  ["/worktree-management/repositories/repo/integration-jobs", "POST", ["startCandidate", "repo", input], 202, "job"],
  ["/worktree-management/repositories/repo/cleanup", "POST", ["cleanupMergedWorktrees", "repo", input], 200, "result", "WorktreeCleanupCompleted"],
  ["/worktree-management/repositories/repo/worktrees/tree/delete", "POST", ["deleteWorktree", "repo", "tree"], 200, "result", "WorktreeDeleted"],
  ["/worktree-management/jobs/job%2Fid", "GET", ["get", "job/id"], 200, "job"],
  ["/worktree-management/jobs/job/confirm", "POST", ["confirm", "job", input], 202, "job"],
  ["/worktree-management/jobs/job/cancel", "POST", ["cancel", "job", input], 202, "job"],
  ["/worktree-management/jobs/job/retry", "POST", ["retry", "job"], 202, "job"],
  ["/worktree-management/jobs/job/resolve-conflict", "POST", ["resolveConflictWithAgent", "job"], 202, "job"],
  ["/projects/project/works/work/integrations", "GET", ["status", "project", "work"], 200],
  ["/projects/project/works/work/integrations", "POST", ["integrateCompleted", "project", "work"], 200],
  ["/projects/project/works/work/integrations/run/conflict-task", "POST", ["createConflictTask", "project", "work", "run", input], 201],
  ["/projects/project/workspaces?activeWorkspaceId=active", "GET", ["listWorkspaces", "project", { activeWorkspaceId: "active" }], 200],
  ["/projects/project/workspaces/tree/actions/refresh", "POST", ["runWorkspaceAction", "project", "tree", "refresh", input], 200, null, "ProjectWorkspaceChanged"],
  ["/projects/project/development-service", "GET", ["readDevelopmentService", "project"], 200],
  ["/projects/project/development-service/actions/initialize", "POST", ["runDevelopmentServiceAction", "project", "initialize", input], 202, null, "ProjectDevelopmentServiceChanged"],
  ["/projects/project/development-service/actions/restart", "POST", ["runDevelopmentServiceAction", "project", "restart", input], 200, null, "ProjectDevelopmentServiceChanged"],
  ["/projects/project%2Fid", "GET", ["readProject", "project/id"], 200]
];

for (const [path, method, call, status, envelope, event] of cases) {
  test(`${method} ${path} preserves dispatch and response`, async () => {
    const f = fixture();
    const request = f.dispatch(path, method);
    assert.equal(request.handled, true);
    assert.deepEqual(await request.response, { status, body: envelope ? { [envelope]: f.result } : f.result });
    assert.deepEqual(f.calls, [call]);
    assert.deepEqual(f.events.map(([type]) => type), event ? [event] : []);
  });
}

test("reused conflict tasks return 200 and failure responses retain recovery details", async () => {
  const f = fixture();
  f.dependencies.projectWorktreeIntegrationService.createConflictTask = async () => ({ reused: true });
  assert.equal((await f.dispatch("/projects/p/works/w/integrations/r/conflict-task", "POST").response).status, 200);
  f.dependencies.projectApplicationService.runWorkspaceAction = async () => { throw Object.assign(new Error("unmerged"), {
    statusCode: 409, code: "UNMERGED", unmergedCommitCount: 3, branchName: "feature"
  }); };
  assert.deepEqual(await f.dispatch("/projects/p/workspaces/w/actions/remove", "POST").response,
    { status: 409, body: { error: "unmerged", code: "UNMERGED", unmergedCommitCount: 3, branchName: "feature" } });
  assert.deepEqual(f.events, []);
});

test("candidate refresh errors retain the fresh candidate and deterministic diff", async () => {
  const f = fixture();
  const candidate = { id: "candidate:fresh" };
  const diff = { changed: true, addedWorktreeIds: ["wt:new"] };
  f.dependencies.worktreeIntegrationJobService.startCandidate = async () => {
    throw Object.assign(new Error("review again"), {
      statusCode: 409, code: "PLAN_REFRESH_REQUIRED", retryable: true, candidate, diff
    });
  };
  assert.deepEqual(
    await f.dispatch("/worktree-management/repositories/r/integration-jobs", "POST").response,
    { status: 409, body: { error: "review again", code: "PLAN_REFRESH_REQUIRED", retryable: true, candidate, diff } }
  );
});

test("new candidate routes contain malformed repository URL encoding", async () => {
  for (const route of ["integration-candidates", "integration-jobs"]) {
    const f = fixture();
    const response = await f.dispatch(
      `/worktree-management/repositories/%ZZ/${route}`,
      "POST"
    ).response;
    assert.deepEqual(response, {
      status: 400,
      body: {
        error: "The repository identifier is malformed.",
        code: "INVALID_REPOSITORY_ID"
      }
    });
    assert.deepEqual(f.calls, []);
  }
});

test("new candidate routes reject non-object JSON bodies", async () => {
  for (const route of ["integration-candidates", "integration-jobs"]) {
    for (const body of [null, []]) {
      const f = fixture();
      f.dependencies.worktreeIntegrationJobService[route === "integration-candidates"
        ? "createCandidate"
        : "startCandidate"] = async (_repositoryId, input) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw Object.assign(new Error("The request body must be a JSON object."), {
            code: "INVALID_REQUEST_BODY",
            statusCode: 400
          });
        }
      };
      const response = await f.dispatch(
        `/worktree-management/repositories/repo/${route}`,
        "POST",
        body
      ).response;
      assert.deepEqual(response, {
        status: 400,
        body: {
          error: "The request body must be a JSON object.",
          code: "INVALID_REQUEST_BODY"
        }
      });
    }
  }
});

test("repository integration jobs do not expose an unbounded list route", () => {
  const f = fixture();
  assert.equal(
    f.dispatch("/worktree-management/repositories/repo/integration-jobs", "GET").handled,
    false
  );
});

test("invalid bodies prevent destructive dispatch and synchronous job errors are contained", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/worktree-management/repositories/r/worktrees/w/delete", "POST", new SyntaxError("bad JSON")).response).status, 400);
  assert.deepEqual(f.calls, []);
  f.dependencies.worktreeIntegrationJobService.get = () => { throw Object.assign(new Error("missing"), { statusCode: 404 }); };
  assert.equal((await f.dispatch("/worktree-management/jobs/missing").response).status, 404);
  assert.equal(f.dispatch("/projects/p", "DELETE").handled, false);
  assert.equal(f.dispatch("/worktree-management/jobs/j/unknown", "POST").handled, false);
});
