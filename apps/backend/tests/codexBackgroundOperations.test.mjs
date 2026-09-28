import test from "node:test";
import assert from "node:assert/strict";
import { createCodexBackgroundOperations } from "../src/adapters/codexBackgroundOperations.mjs";

function fixture({ complete = true } = {}) {
  const calls = [];
  const notifications = [];
  const operations = createCodexBackgroundOperations({
    initialize: async () => { calls.push(["initialize"]); },
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "config/read") return { config: { mcp_servers: {} } };
      return {};
    },
    startThread: async (options) => {
      calls.push(["startThread", options]);
      return { thread: { id: "thread" } };
    },
    startTurn: async (threadId, prompt, options) => {
      calls.push(["startTurn", threadId, prompt, options]);
      if (complete) notifications.push({
        method: "turn/completed",
        params: { threadId, turn: { id: "turn", status: "completed" } }
      });
      return { turn: { id: "turn" } };
    },
    unsubscribeThread: async (id) => { calls.push(["unsubscribe", id]); },
    deleteThread: async (id) => { calls.push(["delete", id]); },
    latestAgentMessageText: () => "answer",
    notificationCount: () => notifications.length,
    notificationsSince: (index) => notifications.slice(index),
    liveThreadCount: () => 0,
    runtimeUserAgent: () => "corptie/0.155.1"
  });
  return { operations, calls };
}

test("no-tools verifies configuration and unsubscribes a completed ephemeral thread", async () => {
  const { operations, calls } = fixture();
  const result = await operations.runEphemeralPrompt({
    executionPolicy: "no-tools", prompt: "transform", cwd: "/workspace"
  });
  assert.equal(result.text, "answer");
  assert.deepEqual(calls.map(([name]) => name), [
    "initialize", "config/read", "startThread", "startTurn", "unsubscribe"
  ]);
  const start = calls.find(([name]) => name === "startThread")[1];
  assert.deepEqual(start.dynamicTools, []);
  assert.deepEqual(start.runtimeWorkspaceRoots, []);
  assert.equal(start.ephemeral, true);
  assert.equal(start.approvalPolicy, "never");
});

test("no-tools timeout interrupts the active turn before unsubscribing", async () => {
  const { operations, calls } = fixture({ complete: false });
  await assert.rejects(operations.runEphemeralPrompt({
    executionPolicy: "no-tools", timeoutMs: 0, cwd: "/workspace"
  }), { code: "BACKGROUND_TIMEOUT" });
  assert.deepEqual(calls.slice(-2), [
    ["turn/interrupt", { threadId: "thread", turnId: "turn" }],
    ["unsubscribe", "thread"]
  ]);
});

test("legacy prompt cleanup and choice parser early return retain their distinct behavior", async () => {
  const legacy = fixture();
  await legacy.operations.runEphemeralPrompt({ cwd: "/workspace" });
  assert.deepEqual(legacy.calls.at(-1), ["delete", "thread"]);
  const choice = fixture({ complete: false });
  const result = await choice.operations.runChoiceParser({ cwd: "/workspace" });
  assert.equal(result.text, "answer");
  assert.deepEqual(choice.calls.map(([name]) => name), ["startThread", "startTurn"]);
});
