import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerUseEnginePreset, findOfficialComputerUseApp, prepareBuiltinComputerUse,
  builtinComputerUseConfig } from "../src/application/computerUseEngine.mjs";
import { isBuiltinComputerUseConfig, isComputerUseMcpConfig } from "../src/application/computerUseGatewayPolicy.mjs";
import { prepareComputerUseBridge } from "../src/application/computerUseBridge.mjs";

const missing = () => { throw Object.assign(Error("missing"), { code: "ENOENT" }); };
const directory = { isDirectory: () => true };
const forbidden = () => { throw Error("unexpected engine fallback"); };

test("only an absent official app selects the independent engine", async () => {
  let independent = 0;
  const result = await computerUseEnginePreset({ platform: "darwin", dataDir: "/data",
    findOfficial: async () => ({ installed: false }), officialPreset: forbidden,
    independentPreset: async () => { independent++; return { runtime: { status: "dependencies_available" }, config: {} }; } });
  assert.equal(independent, 1);
  assert.equal(result.runtime.engine, "independent");
  assert.equal(result.runtime.officialAppInstalled, false);
});

test("installed but broken, uninitialized or unapproved official runtimes never downgrade", async () => {
  for (const status of ["missing_native_service", "missing_runtime", "invalid_signature", "missing_bridge", "needs_os_permissions"]) {
    const result = await computerUseEnginePreset({ platform: "darwin", dataDir: "/data",
      findOfficial: async () => ({ installed: true, appPath: "/Applications/Codex.app" }),
      officialPreset: async ({ discover }) => ({ runtime: await discover(), config: null }),
      discover: async options => { assert.equal(options.appPath, "/Applications/Codex.app"); return { status }; },
      independentPreset: forbidden });
    assert.equal(result.config, null);
    assert.equal(result.runtime.engine, "official");
    assert.equal(result.runtime.status, status);
  }
});

test("ambiguous discovery and unsupported platforms do not launch a fallback", async () => {
  const result = await computerUseEnginePreset({ platform: "darwin", findOfficial: async () => { throw Error("denied"); },
    officialPreset: forbidden, independentPreset: forbidden });
  assert.equal(result.runtime.status, "discovery_failed");
  assert.equal(result.config, null);
  const linux = await computerUseEnginePreset({ platform: "linux", findOfficial: forbidden,
    officialPreset: forbidden, independentPreset: forbidden });
  assert.equal(linux.runtime.status, "unsupported_platform");
});

test("discovery prefers the compatible Codex bundle when classic ChatGPT also exists", async () => {
  const paths = new Set(["/Applications/ChatGPT.app", "/Applications/Codex.app",
    "/Applications/Codex.app/Contents/Resources/cua_node"]);
  const result = await findOfficialComputerUseApp({ home: "/user", fs: { stat: async path => paths.has(path) ? directory : missing() }, search: forbidden });
  assert.equal(result.appPath, "/Applications/Codex.app");
});

test("renamed official bundles remain official and filesystem denial is not absence", async () => {
  const result = await findOfficialComputerUseApp({ home: "/user",
    fs: { stat: async path => path === "/External/Work Desktop.app" ? directory : missing() },
    search: async () => ["relative.app", "/External/Work Desktop.app"] });
  assert.equal(result.appPath, "/External/Work Desktop.app");
  await assert.rejects(findOfficialComputerUseApp({ fs: { stat: async () => {
    throw Object.assign(Error("denied"), { code: "EACCES" }); } }, search: forbidden }), { code: "EACCES" });
});

test("builtin configuration keeps the shared desktop lifecycle and refuses unavailable official engines", async () => {
  const config = builtinComputerUseConfig("/data");
  assert.equal(isBuiltinComputerUseConfig(config), true);
  assert.equal(isComputerUseMcpConfig({ ...config, type: "http" }), false);
  await assert.rejects(prepareBuiltinComputerUse(config, { preset: async () => ({
    runtime: { engine: "official", errorCode: "COMPUTER_USE_NATIVE_SERVICE_MISSING", message: "not ready" }, config: null
  }), prepareOfficial: forbidden }), { code: "COMPUTER_USE_NATIVE_SERVICE_MISSING" });
});

test("official preparation uses the selected bundle and the Session working directory", async () => {
  const config = { ...builtinComputerUseConfig("/data"), cwd: "/data/session" };
  let actual;
  await prepareBuiltinComputerUse(config, {
    preset: async () => ({ runtime: { engine: "official", appPath: "/Applications/Codex.app" }, config: { command: "/official/node" } }),
    prepareOfficial: async (selected, options) => { actual = { selected, options }; return selected; }
  });
  assert.equal(actual.selected.cwd, "/data/session");
  assert.equal(actual.options.runtime.appPath, "/Applications/Codex.app");
});

test("independent preparation has private state without an official account or API key", async t => {
  const root = await mkdtemp(join(tmpdir(), "independent-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await prepareBuiltinComputerUse({ ...builtinComputerUseConfig(root), cwd: join(root, "session") }, {
    preset: async () => ({ runtime: { engine: "independent" }, config: {
      command: "/corptie/node", args: ["/corptie/desktop.mjs"], env: { CORPTIE_COMPUTER_USE_HELPER_PATH: "/corptie/helper" }
    } })
  });
  assert.ok(result.stateRoot.startsWith(join(root, "session", "instance-")));
  for (const key of ["CODEX_HOME", "OPENAI_API_KEY", "NODE_OPTIONS"]) assert.equal(Object.hasOwn(result.env, key), false);
});

test("official broker is pinned to the selected renamed application", async t => {
  const root = await mkdtemp(join(tmpdir(), "official-selected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, "Codex.app");
  const host = join(appPath, "Contents/Resources/codex");
  await mkdir(join(appPath, "Contents/Resources"), { recursive: true });
  await writeFile(host, "signed binary fixture");
  const result = await prepareComputerUseBridge({ cwd: root }, {
    runtime: { status: "dependencies_available", paths: { appPath, nodeModuleDirs: "/signed/modules",
      nodePath: "/signed/node", nodeReplPath: "/signed/repl", serviceAppPath: "/signed/service.app" } },
    buildEnvironment: ({ env }) => ({ ...env, NODE_REPL_TRUSTED_SERVICES: '{"sky":"@oai/sky/service"}' })
  });
  const config = JSON.parse(await readFile(join(result.stateRoot, "config.json"), "utf8"));
  assert.equal(config.codexPath, host);
});
