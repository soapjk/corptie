import assert from "node:assert/strict";
import test from "node:test";
import { handleSettingsReadHttpRequest, handleSettingsUpdateHttpRequest } from "../src/application/settingsHttpApi.mjs";

function fixture() {
  const calls = [];
  const settings = { dataRoot: "/old", choiceParser: { enabled: true }, agentProxy: { enabled: false } };
  const operation = { operationId: "migration", phase: "idle" };
  const dependencies = {
    store: {
      settings: () => settings,
      updateSettings: async (input) => { calls.push(["save", input]); return { ...settings, ...input }; }
    },
    developmentPreview: false,
    dataRootMigrationCoordinator: {
      status: () => operation,
      migrate: async (target) => { calls.push(["migrate", target]); return { ...operation, phase: "restartRequired" }; }
    },
    onSettingsSaved: async (before, after) => calls.push(["saved", before, after]),
    configureChoiceParserRuntime: (input) => calls.push(["parser", input]),
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error, fallback) => error.statusCode ?? fallback
  };
  function dispatch(path = "/settings", method = "PATCH", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const context = { ...dependencies, request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") };
    const handled = handleSettingsReadHttpRequest(context) || handleSettingsUpdateHttpRequest(context);
    return { handled, result };
  }
  return { calls, settings, operation, dependencies, dispatch };
}

test("settings reads expose preview and migration state without mutations", async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch("/settings", "GET").result,
    { status: 200, body: { ...f.settings, developmentPreview: false, dataRootMigration: f.operation } });
  assert.deepEqual(await f.dispatch("/data-root-migrations/current", "GET").result,
    { status: 200, body: { operation: f.operation } });
  assert.deepEqual(f.calls, []);
});

test("invalid roots and stale source preconditions fail before saving", async () => {
  const f = fixture();
  for (const body of [{ dataRoot: " " }, { dataRoot: null }, { expectedSourceDataRoot: "" }]) {
    assert.equal((await f.dispatch("/settings", "PATCH", body).result).body.code, "DATA_ROOT_INVALID");
  }
  const stale = await f.dispatch("/settings", "PATCH", { dataRoot: "/new", expectedSourceDataRoot: "/stale" }).result;
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "DATA_ROOT_SOURCE_CHANGED");
  assert.deepEqual(stale.body.details, { activeDataRoot: "/old" });
  assert.deepEqual(f.calls, []);
});

test("settings persist under the active root before runtime invalidation and migration", async () => {
  const f = fixture();
  const result = await f.dispatch("/settings", "PATCH", { dataRoot: " /new ", expectedSourceDataRoot: "/old", setting: "value" }).result;
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.map(([name]) => name), ["save", "saved", "migrate", "parser"]);
  assert.deepEqual(f.calls[0], ["save", { dataRoot: "/old", setting: "value" }]);
  assert.deepEqual(f.calls[2], ["migrate", "/new"]);
  assert.equal(result.body.dataRoot, "/old");
  assert.equal(result.body.dataRootMigration.phase, "restartRequired");
  assert.deepEqual(f.calls[3][1], { ...f.settings.choiceParser, agentProxy: f.settings.agentProxy });
});

test("equivalent paths do not migrate; migration and runtime failures preserve operation context", async () => {
  const f = fixture();
  await f.dispatch("/settings", "PATCH", { dataRoot: "/old/../old" }).result;
  assert.ok(!f.calls.some(([name]) => name === "migrate"));
  f.calls.length = 0;
  f.dependencies.dataRootMigrationCoordinator.migrate = async () => { throw Object.assign(new Error("blocked"), { code: "MIGRATION_BLOCKED", statusCode: 409 }); };
  const failure = await f.dispatch("/settings", "PATCH", { dataRoot: "/new" }).result;
  assert.equal(failure.status, 409);
  assert.equal(failure.body.code, "MIGRATION_BLOCKED");
  assert.equal(failure.body.operation, f.operation);
  assert.ok(!f.calls.some(([name]) => name === "parser"));
  f.calls.length = 0;
  f.dependencies.onSettingsSaved = async () => { throw new Error("runtime failed"); };
  assert.equal((await f.dispatch().result).body.code, "SETTINGS_UPDATE_FAILED");
  assert.deepEqual(f.calls.map(([name]) => name), ["save"]);
  assert.equal(f.dispatch("/other").handled, false);
});
