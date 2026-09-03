import assert from "node:assert/strict";
import test from "node:test";

import { handleEntityHttpRequest } from "../src/application/entityHttpApi.mjs";

function request(method, path, body = {}) {
  return {
    method,
    headers: { "x-corptie-logical-session-id": "session:source" },
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
    workService: { store: {} },
    startWorkSession: callbacks.start,
    getTaskStartup: callbacks.get,
    getSessionStartupBinding: callbacks.session
  });
  await res.finished;
  return { handled, statusCode: res.statusCode, body: res.body };
}

test("POST start returns only the authoritative ready receipt and polling exposes the same receipt", async () => {
  const ready = {
    status: "ready", idempotentReplay: false,
    session: { id: "provider:one", taskId: "task:one" },
    receipt: { schemaVersion: 2, status: "ready", startupOperationId: "startup:one", receiptHash: "hash" }
  };
  let startInput = null;
  const started = await call("POST", "/tasks/task%3Aone/start", {
    taskId: "task:one",
    assigneeAgentId: "agent:worker", expectedTaskVersion: 1,
    providerId: "codex-app-server", idempotencyKey: "start:one", sourceSessionId: "session:source"
  }, {
    start: (input) => { startInput = input; return ready; }
  });
  assert.equal(started.handled, true);
  assert.equal(started.statusCode, 201);
  assert.deepEqual(started.body, {
    session: ready.session,
    start: { status: "ready", idempotentReplay: false, receipt: ready.receipt }
  });
  assert.equal(startInput.taskId, "task:one");
  assert.equal(startInput.assigneeAgentId, "agent:worker");
  assert.equal(startInput.sourceSessionId, "session:source");
  assert.equal(Object.hasOwn(startInput, "path"), false);
  assert.equal(Object.hasOwn(startInput, "worktreeId"), false);

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
    taskId: "task:one",
    assigneeAgentId: "agent:worker", expectedTaskVersion: 1, providerId: "codex-app-server",
    idempotencyKey: "start:one", sourceSessionId: "session:source", worktreeId: "worktree:forged"
  }, { start: () => { throw new Error("must not run"); } });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, "UNKNOWN_START_FIELD");
});

test("start API returns a ready replay as 200 and rejects legacy Agent aliases", async () => {
  const ready = {
    status: "ready", idempotentReplay: true,
    receipt: { schemaVersion: 2, status: "ready", startupOperationId: "startup:one", receiptHash: "hash" }
  };
  const replay = await call("POST", "/tasks/task%3Aone/start", {
    taskId: "task:one",
    assigneeAgentId: "agent:worker", expectedTaskVersion: 1,
    providerId: "codex-app-server", idempotencyKey: "start:one", sourceSessionId: "session:source"
  }, { start: () => ({ ...ready, session: { id: "provider:one", taskId: "task:one" } }) });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.body, {
    session: { id: "provider:one", taskId: "task:one" },
    start: { status: "ready", idempotentReplay: true, receipt: ready.receipt }
  });

  const legacy = await call("POST", "/tasks/task%3Aone/start", {
    taskId: "task:one", agentId: "agent:worker", providerId: "codex-app-server",
    idempotencyKey: "start:one", sourceSessionId: "session:source"
  }, { start: () => { throw new Error("must not run"); } });
  assert.equal(legacy.statusCode, 400);
  assert.equal(legacy.body.code, "UNKNOWN_START_FIELD");
});
