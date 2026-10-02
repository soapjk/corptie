import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { rejectDevelopmentPreviewWrite, rejectUnavailableStoreRequest } from "../src/application/backendHttpGuards.mjs";

function check(guard, path, method = "GET", overrides = {}) {
  const responses = [];
  const blocked = guard({ request: { method }, response: {}, url: new URL(path, "http://localhost"),
    developmentPreview: true, backendStoreReady: true, store: { migrationInProgress: false },
    dataRootMigrationCoordinator: { status: () => ({ operationId: "operation" }) },
    sendJson: (_response, status, body) => responses.push({ status, body }), ...overrides });
  assert.equal(responses.length, blocked ? 1 : 0);
  return { blocked, response: responses[0] };
}

test("preview permits only the existing read surfaces and denies writes even on readable paths", () => {
  for (const path of ["/health", "/settings", "/first-run", "/events", "/sessions", "/state/snapshot", "/state/changes", "/state/events",
    "/session-timelines/revisions", "/works", "/tasks", "/agents", "/workspaces", "/repositories", "/artifacts", "/memories",
    "/automations", "/scheduled-tasks", "/scheduled-session-tasks", "/scene-templates", "/scenes",
    "/sessions/id/stored-snapshot", "/sessions/id/timeline/window", "/sessions/id/fork", "/sessions/id/images", "/sessions/id/quick-messages",
    "/works/id/tasks", "/tasks/id/snapshots", "/artifacts/id", "/scenes/id/views/view", "/scenes/id/changes"]) {
    assert.equal(check(rejectDevelopmentPreviewWrite, path).blocked, false, path);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const result = check(rejectDevelopmentPreviewWrite, path, method);
      assert.equal(result.response.status, 403);
      assert.equal(result.response.body.code, "DEVELOPMENT_PREVIEW_READ_ONLY");
    }
  }
  for (const path of ["/providers", "/internal/session/tool/catalog", "/projects/id/workspaces", "/sessions/id/interrupt", "/unknown"]) {
    assert.equal(check(rejectDevelopmentPreviewWrite, path).blocked, true);
  }
  assert.equal(check(rejectDevelopmentPreviewWrite, "/unknown", "POST", { developmentPreview: false }).blocked, false);
});

test("initializing Store permits only health, events and settings reads", () => {
  const overrides = { backendStoreReady: false };
  for (const path of ["/health", "/events", "/settings"]) assert.equal(check(rejectUnavailableStoreRequest, path, "GET", overrides).blocked, false);
  for (const [path, method] of [["/sessions", "GET"], ["/settings", "PATCH"], ["/health", "POST"], ["/data-root-migrations/current", "GET"]]) {
    const result = check(rejectUnavailableStoreRequest, path, method, overrides);
    assert.equal(result.response.status, 503);
    assert.equal(result.response.body.code, "BACKEND_STORE_INITIALIZING");
    assert.equal(result.response.body.retryable, true);
  }
});

test("maintenance permits only status reads and the exact restart handoff", () => {
  const overrides = { store: { migrationInProgress: true } };
  for (const [path, method] of [["/health", "GET"], ["/settings", "GET"], ["/data-root-migrations/current", "GET"], ["/internal/backend/data-root-restart", "POST"]]) {
    assert.equal(check(rejectUnavailableStoreRequest, path, method, overrides).blocked, false);
  }
  for (const [path, method] of [["/events", "GET"], ["/sessions", "GET"], ["/internal/backend/data-root-restart", "GET"], ["/internal/backend/data-root-restart/extra", "POST"]]) {
    const result = check(rejectUnavailableStoreRequest, path, method, overrides);
    assert.equal(result.response.body.code, "DATA_ROOT_MAINTENANCE_MODE");
    assert.deepEqual(result.response.body.operation, { operationId: "operation" });
  }
  assert.equal(check(rejectUnavailableStoreRequest, "/sessions", "GET", { ...overrides, backendStoreReady: false }).response.body.code, "BACKEND_STORE_INITIALIZING");
});

test("main router retains foundation-model exception between preview and Store guards", async () => {
  const source = await readFile(new URL("../src/application/backendHttpRouter.mjs", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("function routeBackendHttpRequest(request, response, ports)"));
  const preview = route.indexOf("if (rejectDevelopmentPreviewWrite(");
  const model = route.indexOf("if (handleFoundationModelUpdateHttpRequest(");
  const store = route.indexOf("if (rejectUnavailableStoreRequest(");
  const scene = route.indexOf("if (handleSceneHttpRequest(");
  assert.ok(preview >= 0 && preview < model && model < store && store < scene);
});
