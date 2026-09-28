import assert from "node:assert/strict";
import test from "node:test";
import { handleFoundationModelUpdateHttpRequest, handleChoiceParserTestHttpRequest } from "../src/application/modelSettingsHttpApi.mjs";

function fixture() {
  const calls = [];
  const dependencies = {
    backendStoreReady: true,
    store: { migrationInProgress: false, settings: () => ({ choiceParser: { provider: "fixture", enabled: true }, agentProxy: { enabled: true } }) },
    foundationModelSettings: { save: (input) => { calls.push(["save", input]); return { saved: true }; } },
    agentProviderRegistry: { get: (id) => calls.push(["provider", id]) },
    backgroundAgentService: { cancelCapabilityOperations: () => calls.push(["cancel"]) },
    taskSummaryService: {
      running: new Map([["task", {}]]), request: (id) => calls.push(["request", id]),
      onProviderChanged: () => calls.push(["changed"])
    },
    configureChoiceParserRuntime: (input) => calls.push(["configure", input]),
    parseChoiceStageWithConfiguredParser: async (...args) => { calls.push(["parse", ...args]); return { options: ["one", "two"] }; },
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body })
  };
  function dispatch(path, method, body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const context = { ...dependencies, request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") };
    const handled = handleFoundationModelUpdateHttpRequest(context) || handleChoiceParserTestHttpRequest(context);
    return { handled, result };
  }
  return { calls, dependencies, dispatch };
}

test("foundation model updates reject startup and maintenance without side effects", async () => {
  const f = fixture();
  f.dependencies.backendStoreReady = false;
  assert.equal((await f.dispatch("/settings/foundation-model", "PUT").result).status, 503);
  f.dependencies.backendStoreReady = true;
  f.dependencies.store.migrationInProgress = true;
  assert.equal((await f.dispatch("/settings/foundation-model", "PUT").result).body.retryable, true);
  assert.deepEqual(f.calls, []);
});

test("provider validation and save precede background cancellation and summary refresh", async () => {
  const f = fixture();
  const input = { mode: "provider", providerId: "test" };
  assert.equal((await f.dispatch("/settings/foundation-model", "PUT", input).result).status, 200);
  assert.deepEqual(f.calls, [["provider", "test"], ["save", input], ["cancel"], ["request", "task"], ["changed"]]);
  f.calls.length = 0;
  f.dependencies.agentProviderRegistry.get = () => { throw new Error("private config"); };
  const rejected = await f.dispatch("/settings/foundation-model", "PUT", input).result;
  assert.equal(rejected.status, 400);
  assert.ok(!rejected.body.error.includes("private config"));
  assert.deepEqual(f.calls, []);
});

test("choice parser test merges only supplied overrides and keeps sample identity", async () => {
  const f = fixture();
  const response = await f.dispatch("/settings/choice-parser/test", "POST", { choiceParser: { model: "test" }, agentProxy: { enabled: false } }).result;
  assert.equal(response.status, 200);
  assert.equal(response.body.source, "fixture");
  assert.equal(response.body.confidence, 0);
  assert.ok(response.body.durationMs >= 0);
  assert.deepEqual(f.calls[0], ["configure", { provider: "fixture", enabled: true, model: "test", agentProxy: { enabled: false } }]);
  assert.match(f.calls[1][1], /Please choose one option/);
  assert.deepEqual(f.calls[1][3], { id: "settings-test", provider: "settings" });
});

test("insufficient parser output and parser errors remain distinct", async () => {
  const f = fixture();
  f.dependencies.parseChoiceStageWithConfiguredParser = async () => ({ options: ["one"] });
  assert.equal((await f.dispatch("/settings/choice-parser/test", "POST").result).status, 422);
  f.dependencies.parseChoiceStageWithConfiguredParser = async () => { throw new Error("unavailable"); };
  assert.deepEqual(await f.dispatch("/settings/choice-parser/test", "POST").result,
    { status: 400, body: { ok: false, error: "unavailable" } });
  assert.equal(f.dispatch("/settings/foundation-model", "GET").handled, false);
  assert.equal(f.dispatch("/other", "POST").handled, false);
});
