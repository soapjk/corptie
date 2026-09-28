import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionTurnHttpRequest } from "../src/application/sessionTurnHttpApi.mjs";
import { handlePlatformConfirmationHttpRequest } from "../src/application/platformConfirmationHttpApi.mjs";

function fixture() {
  const calls = [];
  const dependencies = {
    sessionApplicationService: {
      restartSession: async (...args) => { calls.push(["restart", ...args]); return { status: "waitingForTurn" }; },
      manageTurnChanges: async (...args) => { calls.push(["changes", ...args]); return { ok: true }; }
    },
    platformConfirmationService: {
      issue: (input) => { calls.push(["issue", input]); return { id: "confirmation" }; },
      resolve: (...args) => { calls.push(["resolve", ...args]); return { resolved: true }; }
    },
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error, fallback = 400) => error.statusCode ?? fallback,
    unifiedErrorStatus: (error) => error.statusCode ?? 400
  };
  function dispatch(path, body = {}, method = "POST") {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const context = { ...dependencies, request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") };
    const handled = handleSessionTurnHttpRequest(context) || handlePlatformConfirmationHttpRequest(context);
    return { handled, result };
  }
  return { calls, dependencies, dispatch };
}

test("restart accepts only idempotency identity and retains queued status", async () => {
  const f = fixture();
  const invalid = await f.dispatch("/sessions/public/restart", { arbitrary: true }).result;
  assert.equal(invalid.body.code, "SESSION_RESTART_UNKNOWN_FIELD");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.dispatch("/sessions/public%2Fid/restart", { idempotencyKey: " key " }).result).status, 202);
  assert.deepEqual(f.calls[0], ["restart", "public/id", { source: "compatibility-route", idempotencyKey: "key" }]);
  await f.dispatch("/sessions/public/restart").result;
  assert.match(f.calls[1][2].idempotencyKey, /^restart:[0-9a-f-]+$/);
});

test("review and undo use the shared Session service and preserve error details", async () => {
  const f = fixture();
  for (const action of ["review", "undo"]) {
    assert.equal((await f.dispatch(`/sessions/public/turns/turn%2Fid/changes/${action}`).result).status, 200);
    assert.deepEqual(f.calls.at(-1), ["changes", "public", "turn/id", action, { source: "http" }]);
  }
  f.dependencies.sessionApplicationService.manageTurnChanges = async () => { throw Object.assign(new Error("generic"), { stderr: "detailed", code: "CHANGE_FAILED" }); };
  assert.deepEqual(await f.dispatch("/sessions/public/turns/turn/changes/undo").result,
    { status: 400, body: { error: "detailed", code: "CHANGE_FAILED" } });
});

test("confirmation issuance and confirm/reject retain authorization service inputs", async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch("/platform/confirmations", { actorId: "actor", sessionId: "session", tool: "tool" }).result,
    { status: 201, body: { confirmation: { id: "confirmation" } } });
  assert.deepEqual(f.calls[0], ["issue", { actorId: "actor", sessionId: "session", tool: "tool", arguments: {} }]);
  for (const action of ["confirm", "reject"]) {
    assert.equal((await f.dispatch(`/platform/confirmations/confirmation%2Fid/${action}`).result).status, 200);
    assert.deepEqual(f.calls.at(-1), ["resolve", "confirmation/id", action === "confirm"]);
  }
});

test("confirmation failures retain separate issue and resolution statuses", async () => {
  const f = fixture();
  f.dependencies.platformConfirmationService.issue = () => { throw new Error("denied"); };
  f.dependencies.platformConfirmationService.resolve = () => { throw new Error("expired"); };
  assert.equal((await f.dispatch("/platform/confirmations").result).status, 403);
  const rejected = await f.dispatch("/platform/confirmations/id/confirm").result;
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "PLATFORM_CONFIRMATION_FAILED");
  assert.equal(f.dispatch("/sessions/public/restart", {}, "GET").handled, false);
  assert.equal(f.dispatch("/other").handled, false);
});
