import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

test("setThreadName uses the Codex app-server thread naming method", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  await client.setThreadName("thread-a", "Custom session name");

  assert.deepEqual(calls, [{
    method: "thread/name/set",
    params: { threadId: "thread-a", name: "Custom session name" }
  }]);
});

test("startThread forwards collaboration MCP config and allows slow MCP startup", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return { thread: { id: "thread-a" } };
  };

  await client.startThread({
    cwd: "/tmp/workspace",
    config: { mcp_servers: { collaboration: { command: "node" } } },
    developerInstructions: "Stable Agent identity: agent-a"
  });

  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.config.mcp_servers.collaboration.command, "node");
  assert.equal(calls[0].params.developerInstructions, "Stable Agent identity: agent-a");
  assert.equal(calls[0].timeoutMs, 30000);
});

test("resumeThread restores collaboration MCP config and Agent identity", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    return { thread: { id: params.threadId } };
  };

  await client.resumeThread("thread-a", {
    config: { mcp_servers: { collaboration: { command: "node" } } },
    developerInstructions: "Stable Agent identity: agent-a"
  });

  assert.deepEqual(calls, [{
    method: "thread/resume",
    params: {
      threadId: "thread-a",
      config: { mcp_servers: { collaboration: { command: "node" } } },
      developerInstructions: "Stable Agent identity: agent-a"
    },
    timeoutMs: 30000
  }]);
});

test("startTurn forwards application context for rules that must apply to an existing thread", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { turn: { id: "turn-a" } };
  };

  await client.startTurn("thread-a", "Send a peer request", {
    additionalContext: {
      "corptie-agent-runtime": {
        kind: "application",
        value: "Every new user instruction creates a new task."
      }
    }
  });

  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.additionalContext, {
    "corptie-agent-runtime": {
      kind: "application",
      value: "Every new user instruction creates a new task."
    }
  });
});
