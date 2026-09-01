import assert from "node:assert/strict";
import test from "node:test";

import { handleEntityHttpRequest } from "../src/application/entityHttpApi.mjs";

function request(method, path, body = {}) {
  return {
    method,
    headers: {},
    url: `http://localhost${path}`,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); }
  };
}

function response() {
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  return {
    statusCode: 0, body: null, headersSent: false, finished,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body) { this.body = body ? JSON.parse(body) : null; this.headersSent = true; resolveFinished(); }
  };
}

async function call(method, path, body, callbacks = {}) {
  const req = request(method, path, body);
  const res = response();
  const handled = handleEntityHttpRequest({
    request: req,
    response: res,
    url: new URL(req.url),
    objectiveService: { store: {} },
    beginTaskExecution: callbacks.begin,
    getTaskStartup: callbacks.get,
    getSessionStartupBinding: callbacks.session
  });
  await res.finished;
  return { handled, statusCode: res.statusCode, body: res.body };
}

test("POST start returns pending and polling returns only the authoritative ready receipt", async () => {
  const pending = {
    status: "pending", startupOperationId: "startup:one", phase: "allocated",
    resourceVersion: 1, retryAfterMilliseconds: 250, error: null
  };
  const ready = {
    status: "ready", idempotentReplay: false,
    receipt: { schemaVersion: 2, status: "ready", startupOperationId: "startup:one", receiptHash: "hash" }
  };
  let beginInput = null;
  const started = await call("POST", "/tasks/task%3Aone/start", {
    requestedAgentId: "agent:worker", providerId: "codex-app-server", idempotencyKey: "start:one"
  }, {
    begin: (input) => { beginInput = input; return pending; }
  });
  assert.equal(started.handled, true);
  assert.equal(started.statusCode, 202);
  assert.deepEqual(started.body, pending);
  assert.equal(beginInput.taskId, "task:one");
  assert.equal(Object.hasOwn(beginInput, "path"), false);
  assert.equal(Object.hasOwn(beginInput, "worktreeId"), false);

  const polled = await call(
    "GET",
    "/tasks/task%3Aone/startup/startup%3Aone",
    {},
    { get: (input) => {
      assert.deepEqual(input, { taskId: "task:one", startupOperationId: "startup:one" });
      return ready;
    } }
  );
  assert.equal(polled.statusCode, 200);
  assert.deepEqual(polled.body, ready);
});

test("logical Session startup-binding endpoint exposes the same ready receipt", async () => {
  const ready = { status: "ready", receipt: { schemaVersion: 2, status: "ready", receiptHash: "hash" } };
  const result = await call("GET", "/sessions/session%3Aone/startup-binding", {}, {
    session: (id) => { assert.equal(id, "session:one"); return ready; }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, ready);
});

test("start API rejects client-selected Workspace identity fields", async () => {
  const result = await call("POST", "/tasks/task%3Aone/start", {
    requestedAgentId: "agent:worker", providerId: "codex-app-server",
    idempotencyKey: "start:one", worktreeId: "worktree:forged"
  }, { begin: () => { throw new Error("must not run"); } });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "INVALID_INPUT");
});

test("start API returns a ready replay as 200 and rejects legacy Agent aliases", async () => {
  const ready = {
    status: "ready", idempotentReplay: true,
    receipt: { schemaVersion: 2, status: "ready", startupOperationId: "startup:one", receiptHash: "hash" }
  };
  const replay = await call("POST", "/tasks/task%3Aone/start", {
    requestedAgentId: "agent:worker", providerId: "codex-app-server", idempotencyKey: "start:one"
  }, { begin: () => ready });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.body, ready);

  const legacy = await call("POST", "/tasks/task%3Aone/start", {
    agentId: "agent:worker", providerId: "codex-app-server", idempotencyKey: "start:one"
  }, { begin: () => { throw new Error("must not run"); } });
  assert.equal(legacy.statusCode, 400);
  assert.equal(legacy.body.code, "INVALID_INPUT");
});
