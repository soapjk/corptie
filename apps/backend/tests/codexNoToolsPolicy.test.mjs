import assert from "node:assert/strict";
import test from "node:test";
import { assertCodexNoToolsRuntime, codexNoToolsConfig } from "../src/adapters/codexNoToolsPolicy.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

test("no-tools accepts only explicitly qualified complete runtime versions", () => {
  for (const agent of [
    "corptie/0.153.4 (Mac OS; arm64)",
    "corptie/0.155.1 (Mac OS 27.0.0; arm64) unknown (corptie; 0.5.4)",
    "corptie/0.160.0 (Mac OS 27.0.0; arm64) unknown (corptie; 0.5.4)"
  ]) assert.doesNotThrow(() => assertCodexNoToolsRuntime(agent));

  for (const agent of [
    null,
    "corptie/0.155.0",
    "corptie/0.155.2",
    "corptie/0.156.0",
    "corptie/0.155",
    "corptie/0.155.1.0",
    "corptie/0.155.1-beta.1",
    "corptie/0.155.1+build.7",
    "codex-cli/0.155.1",
    "corptie/v0.155.1",
    "invalid"
  ]) {
    assert.throws(() => assertCodexNoToolsRuntime(agent), {
      code: "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED"
    });
  }
});

test("no-tools disables every inherited MCP without copying credentials or invalid null config", () => {
  const policy = codexNoToolsConfig({ remote: { url: "http://localhost/mcp", bearer_token: "secret", tool_timeout_sec: null },
    local: { command: "synthetic", args: ["private"] } });
  assert.deepEqual(policy.mcp_servers, { remote: { url: "http://localhost/mcp", enabled: false },
    local: { command: "synthetic", enabled: false } });
  assert.equal(policy["orchestrator.skills.enabled"], false);
  assert.equal(policy["features.shell_tool"], false);
  assert.equal(policy["features.goals"], false);
});

test("an unverified no-tools runtime never starts a thread or submits a prompt", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => { client.runtimeUserAgent = "corptie/0.149.1"; };
  client.request = async () => assert.fail("No RPC should carry a prompt before verification");
  await assert.rejects(client.runEphemeralPrompt({ executionPolicy: "no-tools" }), {
    code: "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED"
  });
});
