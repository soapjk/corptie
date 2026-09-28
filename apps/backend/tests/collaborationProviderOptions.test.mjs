import test from "node:test";
import assert from "node:assert/strict";
import { createCollaborationProviderOptions } from "../src/adapters/collaborationProviderOptions.mjs";

function fixture() {
  const calls = [];
  const options = createCollaborationProviderOptions({
    agentContextService: { buildAgentContext: async (...args) => {
      calls.push(args);
      return { instructions: "Agent context" };
    } },
    corptieClaudeRuntimePaths: { pluginPath: "/runtime/plugin" },
    collaborationMcpServerPath: "/runtime/mcp.mjs",
    port: 12345,
    environmentName: "development"
  });
  return { options, calls };
}

test("anonymous thread fallback does not create context or MCP attachments", async () => {
  const { options, calls } = fixture();
  assert.deepEqual(await options.collaborationThreadOptionsWithAgentContext(null), {});
  assert.deepEqual(calls, []);
});

test("Codex context is scoped to Session, Work and Task with loopback MCP configuration", async () => {
  const { options, calls } = fixture();
  const metadata = { sessionId: "session", workId: "work", taskId: "task", providerBindingId: "binding" };
  const result = await options.collaborationProviderRuntimeOptionsWithAgentContext("agent", metadata);
  assert.deepEqual(calls, [["agent", { intent: "", scope: { sessionId: "session", workId: "work", taskId: "task" } }]]);
  assert.ok(result.developerInstructions.startsWith("Agent context\n\n"));
  assert.equal(result.config.features.multi_agent, false);
  const servers = Object.values(result.config.mcp_servers);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].command, process.execPath);
  assert.deepEqual(servers[0].args, ["/runtime/mcp.mjs"]);
  assert.equal(servers[0].env.CORPTIE_BACKEND_URL, "http://127.0.0.1:12345");
  assert.equal(servers[0].env.CORPTIE_PROVIDER_BINDING_ID, "binding");
  assert.equal(servers[0].required, false);
  assert.equal(servers[0].startup_timeout_sec, 5);
});

test("Claude preserves its attachment shape and managed plugin path", async () => {
  const { options } = fixture();
  const result = await options.claudeCollaborationRuntimeOptionsWithAgentContext("agent", { sessionId: "session" });
  assert.equal(result.systemPrompt.preset, "claude_code");
  assert.ok(result.systemPrompt.append.startsWith("Agent context\n\n"));
  assert.deepEqual(result.plugins, [{ type: "local", path: "/runtime/plugin", skipMcpDiscovery: true }]);
  const [server] = Object.values(result.mcpServers);
  assert.equal(server.type, "stdio");
  assert.equal(server.timeout, 5000);
  assert.equal(server.alwaysLoad, true);
  const detached = await options.claudeCollaborationRuntimeOptionsWithAgentContext("agent");
  assert.deepEqual(detached.mcpServers, {});
});
