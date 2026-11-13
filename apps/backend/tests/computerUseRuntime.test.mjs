import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverComputerUseRuntime, computerUseMcpConfig, computerUseAvailability } from "../src/application/computerUseRuntime.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corptie-computer-use-runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, "ChatGPT.app");
  const homeDir = join(root, "user-home");
  const serviceAppPath = join(homeDir, ".codex", "computer-use", "Codex Computer Use.app");
  const runtime = join(appPath, "Contents", "Resources", "cua_node");
  const put = async (path, value, options) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, options);
  };
  await put(join(runtime, "bin", "node"), "not executed", { mode: 0o700 });
  await put(join(runtime, "bin", "node_repl"), "not executed", { mode: 0o700 });
  await put(join(runtime, "manifest.json"), JSON.stringify({ platform: "darwin", arch: "arm64", node_version: "24.22.1-cua.1" }));
  const sky = join(runtime, "lib", "node_modules", "@oai", "sky");
  await put(join(sky, "package.json"), JSON.stringify({ name: "@oai/sky", version: "0.7.18", exports: { "./service": "./dist/service.js" } }));
  await put(join(sky, "dist", "service.js"), "not imported");
  await put(join(serviceAppPath, "Contents", "Info.plist"), "not parsed by fixture");
  const verified = [];
  const options = { appPath, homeDir, platform: "darwin",
    readAppMetadata: async path => ({ version: "26.1106.51428", build: "26605",
      bundleIdentifier: path === appPath ? "com.openai.codex" : "com.openai.sky.CUAService" }),
    verifyBundle: async path => { verified.push(path); } };
  return { root, appPath, homeDir, serviceAppPath, runtime, sky, put, options, verified };
}

test("discovery is dependency evidence, verifies both bundles, and never claims OS or protocol readiness", async t => {
  const f = await fixture(t);
  const result = await discoverComputerUseRuntime(f.options);
  assert.equal(result.status, "dependencies_available");
  assert.deepEqual(f.verified, [f.appPath, f.serviceAppPath]);
  assert.equal(result.permissions, "unknown");
  assert.equal(result.protocol, "unverified");
  assert.equal(result.versions.sky, "0.7.18");
  assert.match(result.runtimeRevision, /^[a-f0-9]{64}$/);
  const same = await discoverComputerUseRuntime(f.options);
  assert.equal(same.runtimeRevision, result.runtimeRevision);
  await f.put(join(f.runtime, "bin", "node_repl"), "changed executable generation", { mode: 0o700 });
  assert.notEqual((await discoverComputerUseRuntime(f.options)).runtimeRevision, result.runtimeRevision);
});

test("non-macOS discovery does not inspect local paths or launch a command", async () => {
  const result = await discoverComputerUseRuntime({ platform: "linux", appPath: "invalid", fs: new Proxy({}, {
    get() { throw new Error("filesystem must not be touched"); }
  }) });
  assert.equal(result.errorCode, "COMPUTER_USE_PLATFORM_UNSUPPORTED");
});

test("missing app, runtime and native installation are distinct and do not expose filesystem errors", async t => {
  const f = await fixture(t);
  assert.equal((await discoverComputerUseRuntime({ ...f.options, appPath: join(f.root, "missing.app") })).status, "missing_app");
  await rm(join(f.runtime, "bin", "node_repl"));
  assert.equal((await discoverComputerUseRuntime(f.options)).status, "missing_runtime");
  await f.put(join(f.runtime, "bin", "node_repl"), "restored", { mode: 0o700 });
  await rm(f.serviceAppPath, { recursive: true });
  const missing = await discoverComputerUseRuntime(f.options);
  assert.equal(missing.status, "missing_native_service");
  assert.equal(missing.versions.sky, "0.7.18");
  assert.throws(() => computerUseMcpConfig(missing, { codexHome: join(f.root, "isolated") }), { code: "COMPUTER_USE_DEPENDENCIES_UNAVAILABLE" });
});

test("tampered bundle, escaped module code and incompatible metadata fail closed", async t => {
  const f = await fixture(t);
  const invalidSignature = await discoverComputerUseRuntime({ ...f.options, verifyBundle: async () => {
    throw new Error("private filesystem details");
  } });
  assert.deepEqual(invalidSignature, { status: "invalid_signature", errorCode: "COMPUTER_USE_SIGNATURE_INVALID" });
  await f.put(join(f.runtime, "manifest.json"), JSON.stringify({ platform: "win32", node_version: "24" }));
  assert.equal((await discoverComputerUseRuntime(f.options)).status, "invalid_runtime");
  await f.put(join(f.runtime, "manifest.json"), JSON.stringify({ platform: "darwin", node_version: "24" }));
  const outside = join(f.root, "outside-service.js");
  await f.put(outside, "must not load");
  await rm(join(f.sky, "dist", "service.js"));
  await symlink(outside, join(f.sky, "dist", "service.js"));
  assert.equal((await discoverComputerUseRuntime(f.options)).status, "invalid_runtime");
});

test("MCP config contains only fixed official services and the isolated Session home", async t => {
  const f = await fixture(t);
  const result = await discoverComputerUseRuntime(f.options);
  const codexHome = join(f.root, "session-home");
  const config = computerUseMcpConfig(result, { codexHome });
  assert.equal(config.type, "stdio");
  assert.equal(config.isolatedEnv, true);
  assert.equal(config.cwd, codexHome);
  assert.equal(config.env.CODEX_HOME, codexHome);
  assert.equal(config.env.NODE_REPL_TRUSTED_CODE_PATHS, result.paths.nodeModuleDirs);
  assert.deepEqual(JSON.parse(config.env.NODE_REPL_TRUSTED_SERVICES), { sky: "@oai/sky/service" });
  assert.equal(config.env.SKY_CUA_SERVICE_PATH, f.serviceAppPath);
  assert.equal(config.env.NODE_REPL_DISABLE_ANALYTICS, "1");
  assert.equal(config.observationRevision, result.runtimeRevision);
  assert.deepEqual(config.toolAllowlist, ["js", "js_reset", "turn_ended"]);
  for (const key of ["NODE_REPL_TRUSTED_RPC_ENABLED", "NODE_REPL_PRIVATE_KEYS_STDIN", "NODE_REPL_REQUEST_META", "NODE_OPTIONS", "HOME"]) {
    assert.equal(Object.hasOwn(config.env, key), false, key);
  }
  assert.throws(() => computerUseMcpConfig(result, { codexHome: "relative" }), { code: "COMPUTER_USE_PATH_INVALID" });
});

test("availability requires explicit supported Provider, full protocol proof and OS permission evidence", () => {
  const runtime = { status: "dependencies_available", runtimeRevision: "generation-1" };
  const protocol = { nativeConnection: true, appApprovals: true, images: true, cancellation: true, context: true };
  const permissions = { accessibility: true, screenRecording: true };
  assert.equal(computerUseAvailability(runtime).status, "disabled");
  assert.equal(computerUseAvailability(runtime, { enabled: true }).status, "unsupported_provider");
  assert.deepEqual(computerUseAvailability(runtime, { enabled: true, supported: true }).missingProtocols,
    ["nativeConnection", "appApprovals", "images", "cancellation", "context"]);
  assert.equal(computerUseAvailability(runtime, { enabled: true, supported: true, protocol }).status, "permissions_unknown");
  assert.equal(computerUseAvailability(runtime, { enabled: true, supported: true, protocol,
    permissions: { accessibility: false } }).status, "needs_os_permissions");
  assert.equal(computerUseAvailability(runtime, { enabled: true, supported: true, protocol, permissions }).status, "ready");
  assert.equal(computerUseAvailability({ status: "missing_runtime" }, { enabled: true, supported: true }).status, "missing_runtime");
});
