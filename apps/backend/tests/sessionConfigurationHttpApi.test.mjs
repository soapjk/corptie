import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionConfigurationHttpRequest } from "../src/application/sessionConfigurationHttpApi.mjs";
import { normalizeCodexSandbox, normalizeCodexApprovalPolicy } from "../src/utils/codexPermissions.mjs";

function fixture() {
  const calls = [];
  const events = [];
  const reference = { sessionId: "stored", logicalSessionId: "logical" };
  const session = { id: "stored" };
  const record = (name) => async (...args) => { calls.push([name, ...args]); return session; };
  const service = {
    switchModel: record("model"), switchReasoning: record("reasoning"), updatePermissions: record("permissions"),
    referenceFor: async (id) => { calls.push(["reference", id]); return reference; }
  };
  function dispatch(path, body = {}, method = "POST") {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const handled = handleSessionConfigurationHttpRequest({
      request: { method }, response: { resolve }, url: new URL(path, "http://localhost"),
      sessionApplicationService: service,
      requireSessionReference: (id) => { calls.push(["reference", id]); return reference; },
      normalizeSandbox: normalizeCodexSandbox, normalizeApprovalPolicy: normalizeCodexApprovalPolicy,
      emitEvent: (...args) => events.push(args),
      readJson: async () => { if (body instanceof Error) throw body; return body; },
      sendJson: (response, status, payload) => response.resolve({ status, body: payload }),
      unifiedErrorStatus: (error) => error.statusCode ?? 400
    });
    return { handled, result };
  }
  return { calls, events, service, session, dispatch };
}

for (const [route, field, value, event] of [
  ["model", "model", "model-id", "SessionModelChanged"],
  ["reasoning", "reasoningLevel", "high", "SessionReasoningChanged"]
]) {
  test(`${route} trims input and publishes only after the shared service succeeds`, async () => {
    const f = fixture();
    const result = await f.dispatch(`/sessions/public%2Fid/${route}`, { [field]: ` ${value} ` }).result;
    assert.deepEqual(f.calls, [["reference", "public/id"], [route, "public/id", value]]);
    assert.deepEqual(result, { status: 202, body: { session: f.session, [field]: value } });
    assert.deepEqual(f.events, [[event, { sessionId: "stored", logicalSessionId: "logical", [field]: value }, { sessionId: "stored" }]]);
  });
  test(`${route} rejects empty input without service calls or events`, async () => {
    const f = fixture();
    for (const value of ["", "  ", 42, null]) {
      assert.equal((await f.dispatch(`/sessions/public/${route}`, { [field]: value }).result).status, 400);
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.events, []);
  });
}

test("permission updates preserve accepted vocabulary and shared service source", async () => {
  for (const sandbox of ["workspace-write", "danger-full-access", "read-only"]) {
    for (const approvalPolicy of ["on-request", "ask-risky", "never", "on-failure"]) {
      const f = fixture();
      const result = await f.dispatch("/sessions/public/permissions", { sandbox, approvalPolicy }).result;
      const normalized = { sandbox: normalizeCodexSandbox(sandbox, ""), approvalPolicy: normalizeCodexApprovalPolicy(approvalPolicy, "") };
      assert.equal(result.status, 202);
      assert.deepEqual(f.calls[1], ["permissions", "public", normalized, { source: { type: "desktop" } }]);
      assert.deepEqual(f.events, [["SessionPermissionsChanged", { sessionId: "stored", logicalSessionId: "logical", ...normalized }, { sessionId: "stored" }]]);
    }
  }
});

test("invalid permissions and service rejection never publish a success event", async () => {
  const f = fixture();
  for (const body of [{ sandbox: "invalid", approvalPolicy: "never" }, { sandbox: "read-only", approvalPolicy: "invalid" }]) {
    assert.equal((await f.dispatch("/sessions/public/permissions", body).result).status, 400);
  }
  assert.deepEqual(f.calls, []);
  f.service.updatePermissions = async () => { throw Object.assign(new Error("unsupported"), { statusCode: 409, code: "UNSUPPORTED" }); };
  assert.deepEqual(await f.dispatch("/sessions/public/permissions", { sandbox: "read-only", approvalPolicy: "never" }).result,
    { status: 409, body: { error: "unsupported", code: "UNSUPPORTED" } });
  assert.deepEqual(f.events, []);
});

test("parse failures and unrelated requests preserve error and fallthrough behavior", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/sessions/public/model", new SyntaxError("invalid JSON")).result).status, 400);
  assert.equal(f.dispatch("/sessions/public/model", {}, "GET").handled, false);
  assert.equal(f.dispatch("/other").handled, false);
  assert.deepEqual(f.calls, []);
});
