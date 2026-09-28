import assert from "node:assert/strict";
import test from "node:test";
import { handleProviderModelsHttpRequest, handleProviderSetupHttpRequest } from "../src/application/providerSetupHttpApi.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

function fixture() {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const dependencies = {
    sessionApplicationService: { listModels: record("models") },
    agentProviderRegistry: { defaultProviderId: "test", descriptors: () => [{ id: "test" }], invoke: record("invoke") },
    firstRunSetup: Object.fromEntries(["status", "check", "setEnabled", "prepareAssistant", "complete"].map((name) => [name, record(name)])),
    readJson: async (request) => { if (request.body instanceof Error) throw request.body; return request.body; },
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error, fallback) => Number.isInteger(error.statusCode) ? error.statusCode : fallback,
    unifiedErrorStatus: (error) => error.statusCode ?? 400
  };
  function dispatch(path, method = "GET", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const context = { ...dependencies, request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") };
    const handled = handleProviderModelsHttpRequest(context) || handleProviderSetupHttpRequest(context);
    return { handled, result };
  }
  return { calls, dependencies, dispatch };
}

test("model catalogs decode provider IDs and catch synchronous registry failures", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/providers/test%2Fprovider/models?refresh=true").result).status, 200);
  assert.deepEqual(f.calls, [["models", "test/provider", { refresh: true }]]);
  f.dependencies.sessionApplicationService.listModels = () => { throw Object.assign(new Error("missing"), { code: "PROVIDER_NOT_FOUND", statusCode: 404 }); };
  assert.deepEqual(await f.dispatch("/providers/missing/models").result,
    { status: 404, body: { error: "missing", code: "PROVIDER_NOT_FOUND" } });
});

test("provider validation and connection tests use shared capabilities", async () => {
  const f = fixture();
  const input = { configuration: { endpoint: "fixture" } };
  for (const [action, capability] of [["configuration/validate", AGENT_PROVIDER_CAPABILITIES.CONFIGURATION_VALIDATE], ["connection-test", AGENT_PROVIDER_CAPABILITIES.CONNECTION_TEST]]) {
    assert.equal((await f.dispatch(`/providers/test%2Fprovider/${action}`, "POST", input).result).status, 200);
    assert.deepEqual(f.calls.at(-1), ["invoke", "test/provider", capability, input]);
  }
  f.dependencies.agentProviderRegistry.invoke = () => { throw Object.assign(new Error("invalid"), { statusCode: 422, retryable: true, details: ["endpoint"] }); };
  assert.deepEqual(await f.dispatch("/providers/test/configuration/validate", "POST").result,
    { status: 422, body: { ok: false, error: "invalid", code: "PROVIDER_CONFIGURATION_FAILED", retryable: true, details: ["endpoint"] } });
});

test("first-run routes retain exact dispatch and argument contracts", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/first-run").result).status, 200);
  assert.deepEqual(f.calls[0], ["status"]);
  const input = { providerId: "test" };
  for (const [path, name, args] of [["provider", "setEnabled", [input]], ["check", "check", [input]], ["assistant", "prepareAssistant", []], ["complete", "complete", []]]) {
    assert.equal((await f.dispatch(`/first-run/${path}`, "POST", input).result).status, 200);
    assert.deepEqual(f.calls.at(-1), [name, ...args]);
  }
  const count = f.calls.length;
  assert.equal((await f.dispatch("/first-run/complete", "POST", new SyntaxError("bad JSON")).result).status, 400);
  assert.equal(f.calls.length, count);
});

test("provider inventory and unmatched methods preserve response and fallthrough", async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch("/providers").result,
    { status: 200, body: { defaultProviderId: "test", providers: [{ id: "test" }] } });
  assert.equal(f.dispatch("/providers", "POST").handled, false);
  assert.equal(f.dispatch("/first-run/unknown", "POST").handled, false);
  assert.equal(f.dispatch("/other").handled, false);
});
