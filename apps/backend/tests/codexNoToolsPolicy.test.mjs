import assert from "node:assert/strict";
import test from "node:test";
import { codexNoToolsConfig } from "../src/adapters/codexNoToolsPolicy.mjs";

test("no-tools disables every inherited MCP without copying credentials or invalid null config", () => {
  const policy = codexNoToolsConfig({ remote: { url: "http://localhost/mcp", bearer_token: "secret", tool_timeout_sec: null },
    local: { command: "synthetic", args: ["private"] } });
  assert.deepEqual(policy.mcp_servers, { remote: { url: "http://localhost/mcp", enabled: false },
    local: { command: "synthetic", enabled: false } });
  assert.equal(policy["orchestrator.skills.enabled"], false);
  assert.equal(policy["features.shell_tool"], false);
  assert.equal(policy["features.goals"], false);
});
