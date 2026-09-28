import assert from "node:assert/strict";
import test from "node:test";
import { createProjectToolsetStatusReader } from "../src/application/projectToolsetStatusReader.mjs";

function fixture() {
  const calls = [];
  const toolset = { configured: true, mainPath: "/main", runtimePath: "/runtime", selectedProfile: "development" };
  const reader = createProjectToolsetStatusReader({
    projectToolsets: {
      inspect: async () => toolset,
      sourceIdentity: async () => ({ revision: "head", fingerprint: "fingerprint" }),
      run: async (_cwd, action, options) => {
        calls.push([action, options]);
        return { payload: action === "status" ? { running: true }
          : action === "health" ? { healthy: true } : { revision: "head", profile: "development" } };
      },
      revisionDetails: async () => ({ branch: "main", commitTime: "time" })
    },
    readInitializationStatus: async () => ({ state: "notInitialized", error: null }),
    getProduction: () => null,
    runtimeSourceIdentity: (value) => value
  });
  return { reader, toolset, calls };
}

test("configuration failures do not launch service status scripts", async () => {
  const f = fixture();
  f.toolset.configurationError = "invalid manifest";
  const result = await f.reader.projectToolsetStatusForPath("/main");
  assert.equal(result.service.state, "configurationFailed");
  assert.equal(result.service.running, null);
  assert.deepEqual(f.calls, []);
});

test("unconfigured projects report initializer status without executing scripts", async () => {
  const f = fixture();
  f.toolset.configured = false;
  const result = await f.reader.projectToolsetStatusForPath("/main");
  assert.equal(result.service.state, "notInitialized");
  assert.deepEqual(f.calls, []);
});

test("configured status remains unverified without an authenticated verification action", async () => {
  const f = fixture();
  const result = await f.reader.projectToolsetStatusForPath("/main");
  assert.deepEqual(f.calls.map(([action]) => action), ["status", "health", "version"]);
  assert.equal(result.service.verified, false);
  assert.equal(result.service.freshness, "unverifiedBuild");
  assert.equal(result.service.verify.code, "DEPENDENCY_CONTRACT_UNRESOLVED");
  assert.equal(result.service.runningBranch, "main");
});

test("legacy manifests use compatibility status probes and advertise update required", async () => {
  const f = fixture();
  Object.assign(f.toolset, { requiresUpdate: true, manifestConfigured: true });
  const result = await f.reader.projectToolsetStatusForPath("/main");
  assert.equal(result.service.freshness, "toolsetUpdateRequired");
  assert.ok(f.calls.every(([, options]) => options.allowIncompatible === true));
});
