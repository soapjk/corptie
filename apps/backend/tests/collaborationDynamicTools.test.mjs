import assert from "node:assert/strict";
import test from "node:test";
import {
  callCollaborationDynamicTool,
  collaborationDynamicTools
} from "../src/collaboration/collaborationDynamicTools.mjs";

test("dynamic collaboration tools are top-level, eagerly loaded, unique, and provider-safe", () => {
  const names = collaborationDynamicTools.map((entry) => entry.name);
  assert.equal(names.length, 15);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("corptie_agents_discover"));
  assert.ok(names.includes("corptie_collaboration_request"));
  for (const entry of collaborationDynamicTools) {
    assert.equal(entry.type, "function");
    assert.equal(entry.deferLoading, false);
    assert.ok(entry.name.length < 64);
    assert.equal(entry.inputSchema.type, "object");
  }
});

test("dynamic request maps tool input to the authenticated collaboration HTTP contract", async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push({ path, body });
      return { confirmation: { id: "confirmation-a" } };
    }
  };

  const result = await callCollaborationDynamicTool(client, "corptie_collaboration_request", {
    recipient_agent_id: "agent-b",
    type: "change_request",
    title: "Update API",
    summary: "Add the endpoint"
  });

  assert.deepEqual(calls, [{
    path: "/internal/collaboration/task-confirmations",
    body: {
      recipientAgentId: "agent-b",
      type: "change_request",
      title: "Update API",
      summary: "Add the endpoint",
      acceptanceCriteria: [],
      maxIterations: 3
    }
  }]);
  assert.equal(result.coordination.delivery, "awaiting_user_confirmation");
  assert.equal(result.coordination.nextAction, "end_current_turn");
});

test("dynamic read tools use the same backend endpoints as the MCP transport", async () => {
  const calls = [];
  const client = {
    get: async (path, search) => {
      calls.push({ path, search });
      return { agents: [] };
    }
  };

  const result = await callCollaborationDynamicTool(client, "corptie_agents_discover", {
    status: "available"
  });

  assert.deepEqual(calls, [{
    path: "/internal/collaboration/agents",
    search: { status: "available" }
  }]);
  assert.deepEqual(result, { agents: [] });
});
