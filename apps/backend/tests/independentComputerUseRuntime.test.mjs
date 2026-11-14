import test from "node:test";
import assert from "node:assert/strict";
import { independentComputerUsePreset, independentComputerUseEntry } from "../src/application/independentComputerUseRuntime.mjs";

const available = () => ({ access: async () => {}, stat: async () => ({ isFile: () => true }), mkdir: async () => {} });
test("independent preset uses bundled Corptie helper, absolute MCP entry and managed cwd", async () => {
  const dirs = [];
  const fs = available(); fs.mkdir = async (...args) => dirs.push(args);
  const { runtime, config } = await independentComputerUsePreset({ dataDir: "/managed", platform: "darwin", helperPath: "/bundle/CorptieComputerUse", fs });
  assert.equal(runtime.status, "dependencies_available");
  assert.equal(runtime.engine, "independent");
  assert.equal(runtime.permissions, "unknown");
  assert.equal(runtime.protocol, "unverified");
  assert.equal(config.runtimeProfile, "corptie-computer-use/v1");
  assert.equal(config.command, process.execPath);
  assert.deepEqual(config.args, [independentComputerUseEntry]);
  assert.equal(config.cwd, "/managed/computer-use/independent");
  assert.equal(config.env.CORPTIE_COMPUTER_USE_HELPER, "/bundle/CorptieComputerUse");
  assert.equal(dirs[0][1].mode, 0o700);
});
test("missing helper and unsupported platforms do not claim readiness or launch anything", async () => {
  const fs = available(); fs.access = async () => { throw new Error("ENOENT"); };
  assert.equal((await independentComputerUsePreset({ dataDir: "/managed", platform: "darwin", fs })).runtime.status, "missing_helper");
  fs.stat = async () => { throw new Error("must not probe on unsupported platform"); };
  assert.equal((await independentComputerUsePreset({ dataDir: "/managed", platform: "linux", fs })).runtime.status, "unsupported_platform");
  await assert.rejects(independentComputerUsePreset({ dataDir: "relative" }), /absolute/);
});
