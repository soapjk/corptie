import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionRecoveryHttpRequest, handleSessionExecutionHttpRequest } from "../src/application/sessionExecutionHttpApi.mjs";

function fixture() {
  const calls = [];
  const record = (name, value) => async (...args) => { calls.push([name, ...args]); return value; };
  const reference = { logicalSessionId: "logical", providerId: "test" };
  const dependencies = {
    store: { listSessionRecoveryAttempts: (id) => { calls.push(["attempts", id]); return []; } },
    requireSessionReference: (id) => { calls.push(["reference", id]); return reference; },
    sessionRecoveryCoordinator: { recover: record("recover", { state: "committed" }), cancel: record("cancel", { state: "canceled" }) },
    sessionApplicationService: {
      prepareExecution: record("prepare", { ready: true }),
      resumeSession: record("resume", { id: "session" }),
      disconnectSession: record("disconnect", { id: "session" })
    },
    sessionBindingReadinessProbe: { verify: record("verify", { ready: true }) },
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error, fallback) => error.statusCode ?? fallback,
    unifiedErrorStatus: (error) => error.statusCode ?? 400
  };
  function dispatch(path, method = "POST", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const context = { ...dependencies, request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") };
    const handled = handleSessionRecoveryHttpRequest(context) || handleSessionExecutionHttpRequest(context);
    return { handled, result };
  }
  return { calls, reference, dependencies, dispatch };
}

test("recovery reads expose limitations and manual requests retain idempotency fields", async () => {
  const f = fixture();
  const read = await f.dispatch("/sessions/public%2Fid/recovery", "GET").result;
  assert.equal(read.status, 200);
  assert.equal(read.body.limitations.length, 4);
  assert.deepEqual(f.calls, [["reference", "public/id"], ["attempts", "logical"]]);
  assert.equal((await f.dispatch("/sessions/public/recovery", "POST", { idempotencyKey: " key " }).result).status, 200);
  assert.deepEqual(f.calls.at(-1), ["recover", { logicalSessionId: "logical", providerId: "test", idempotencyKey: "key", reason: "manual-provider-session-recovery" }]);
  f.dependencies.sessionRecoveryCoordinator.recover = async () => ({ state: "failed" });
  assert.equal((await f.dispatch("/sessions/public/recovery").result).status, 409);
});

test("recovery rejects unknown fields and missing logical identities before execution", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/sessions/public/recovery", "POST", { unexpected: true }).result).body.code, "RECOVERY_UNKNOWN_FIELD");
  assert.deepEqual(f.calls, []);
  f.reference.logicalSessionId = null;
  for (const method of ["GET", "POST"]) {
    assert.equal((await f.dispatch("/sessions/public/recovery", method).result).body.code, "LOGICAL_SESSION_REQUIRED");
  }
  assert.ok(f.calls.every(([name]) => name === "reference"));
});

test("recovery cancellation preserves decoded identity and missing-attempt response", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/session-recovery/attempt%2Fid/cancel").result).status, 200);
  assert.deepEqual(f.calls[0], ["cancel", "attempt/id"]);
  f.dependencies.sessionRecoveryCoordinator.cancel = async () => null;
  assert.equal((await f.dispatch("/session-recovery/missing/cancel").result).status, 404);
});

for (const [path, call, envelope] of [
  ["/sessions/public%2Fid/actions/prepare-execution", ["prepare", "public/id", { source: "http-session-selection" }], "preparation"],
  ["/sessions/public/actions/probe-binding", ["verify", "public"], "verification"],
  ["/sessions/public/actions/resume", ["resume", "public", { source: "http" }], "session"],
  ["/pty/sessions/public/disconnect", ["disconnect", "public", { source: "legacy-http" }], "session"],
  ["/pty/sessions/public/reconnect", ["resume", "public", { source: "legacy-http" }], "session"]
]) {
  test(`${path} retains shared-service dispatch and caller source`, async () => {
    const f = fixture();
    const response = await f.dispatch(path).result;
    assert.equal(response.status, 200);
    assert.ok(response.body[envelope]);
    assert.deepEqual(f.calls, [call]);
  });
}

test("execution errors remain structured and unmatched methods fall through", async () => {
  const f = fixture();
  f.dependencies.sessionApplicationService.resumeSession = async () => { throw Object.assign(new Error("unavailable"), { code: "UNAVAILABLE", statusCode: 503 }); };
  assert.deepEqual(await f.dispatch("/sessions/public/actions/resume").result,
    { status: 503, body: { error: "unavailable", code: "UNAVAILABLE" } });
  assert.equal(f.dispatch("/sessions/public/actions/resume", "GET").handled, false);
  assert.equal(f.dispatch("/other").handled, false);
});
