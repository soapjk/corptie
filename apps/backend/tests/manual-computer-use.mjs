// Explicit local protocol probe: never approves an app, captures a window or types.
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { connectCodexComputerUseRuntime } from "../src/adapters/codexComputerUseRuntime.mjs";
import { discoverComputerUseRuntime, computerUseMcpConfig } from "../src/application/computerUseRuntime.mjs";

const runtime = await discoverComputerUseRuntime();
assert.equal(runtime.status, "dependencies_available", runtime.errorCode);
await access(join(homedir(), "Library", "Group Containers", "2DC432GLL2.com.openai.sky.CUAService", "IPC", "computeruse.sock"));
const home = await mkdtemp(join(tmpdir(), "corptie-computer-use-protocol-"));
const config = computerUseMcpConfig(runtime, { codexHome: home });
let client;
let requests = 0;
try {
  client = await connectCodexComputerUseRuntime({ ...config,
    env: { ...config.env, SKY_CUA_SERVICE_PATH: join(home, "NO_SERVICE_START.app") } }, {
    onElicitation: async (_client, request) => {
      requests += 1;
      assert.equal(request.params._meta?.connector_id, "computer-use");
      console.log("Official app approval received; declined without reading app content.");
      return { action: "decline" };
    }
  });
  const result = await client.callTool({ name: "js", arguments: {
    code: 'var sky=(await import("@oai/sky")).sky; try { await sky.get_app_state({app:"com.apple.calculator"}); nodeRepl.write("UNEXPECTED_APP_READ"); } catch(e) { nodeRepl.write(e.message); }',
    title: "Verify official app rejection without desktop interaction", timeout_ms: 15_000
  } }, undefined, { timeout: 20_000 });
  const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.equal(requests, 1, `The official runtime must reach the app approval boundary. Runtime returned: ${text.slice(0, 500)}`);
  assert.match(text, /not approved/);
  assert.doesNotMatch(text, /UNEXPECTED_APP_READ/);
  console.log("PASS: official runtime -> native policy -> MCP approval -> explicit decline.");
} finally {
  await client?.close();
  await rm(home, { recursive: true, force: true });
}
