import assert from "node:assert/strict";
import test from "node:test";
import {
  callCollaborationDynamicTool,
  collaborationDynamicTools
} from "../src/collaboration/collaborationDynamicTools.mjs";

test("dynamic collaboration tools are top-level, eagerly loaded, unique, and provider-safe", () => {
  const names = collaborationDynamicTools.map((entry) => entry.name);
  assert.equal(names.length, 25);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("corptie_agents_discover"));
  assert.ok(names.includes("corptie_collaboration_request"));
  assert.ok(names.includes("corptie_sessions_discover"));
  assert.ok(names.includes("corptie_collaboration_work_items_create"));
  assert.ok(names.includes("corptie_collaboration_work_items_share_artifact"));
  assert.equal(names.some((name) => name.includes("work_items_delete") || name.includes("work_items_update")), false);
  for (const entry of collaborationDynamicTools) {
    assert.equal(entry.type, "function");
    assert.equal(entry.deferLoading, false);
    assert.ok(entry.name.length < 64);
    assert.equal(entry.inputSchema.type, "object");
    assert.equal(entry.inputSchema.additionalProperties, false);
  }
  const request = collaborationDynamicTools.find((entry) => entry.name === "corptie_collaboration_request");
  assert.equal(Object.hasOwn(request.inputSchema.properties, "parent_task_id"), false);
  assert.equal(Object.hasOwn(request.inputSchema.properties, "context_id"), false);
  const createWorkItem = collaborationDynamicTools.find((entry) => entry.name === "corptie_collaboration_work_items_create");
  assert.equal(createWorkItem.inputSchema.properties.artifact_reference.required[0], "artifact_id");
  assert.equal(createWorkItem.inputSchema.properties.file_reference.required[0], "path");
});

test("dynamic Artifact sharing maps a read-only WorkItem reference request", async () => {
  const calls = [];
  const client = { post: async (path, body) => { calls.push({ path, body }); return { access: "read_only" }; } };
  const result = await callCollaborationDynamicTool(client, "corptie_collaboration_work_items_share_artifact", {
    work_item_id: "work_item:target", artifact_id: "artifact:owned",
    relation: "handoff", required: true, version_policy: "fixed", version: 1
  });
  assert.deepEqual(calls, [{
    path: "/internal/collaboration/work-item-artifact-references",
    body: {
      workItemId: "work_item:target", artifactId: "artifact:owned",
      relation: "handoff", required: true, versionPolicy: "fixed", version: 1
    }
  }]);
  assert.equal(result.access, "read_only");
});

test("dynamic WorkItem creation maps Artifact and file reference contracts without dropping fields", async () => {
  const calls = [];
  const client = { post: async (path, body) => { calls.push({ path, body }); return { workItem: { id: "work_item:new" } }; } };
  await callCollaborationDynamicTool(client, "corptie_collaboration_work_items_create", {
    title: "Referenced", idempotency_key: "create:referenced",
    artifact_reference: {
      artifact_id: "artifact:spec", relation: "implementation_spec", required: true,
      version_policy: "fixed", version: 2
    }
  });
  assert.deepEqual(calls[0], {
    path: "/internal/collaboration/work-items",
    body: {
      title: "Referenced",
      artifactReference: {
        artifactId: "artifact:spec", relation: "implementation_spec", required: true,
        versionPolicy: "fixed", version: 2
      },
      idempotencyKey: "create:referenced"
    }
  });
  calls.length = 0;
  await callCollaborationDynamicTool(client, "corptie_collaboration_work_items_create", {
    title: "File", idempotency_key: "create:file",
    file_reference: { path: "/workspace/spec.md", relation: "test_plan", required: false }
  });
  assert.equal(calls[0].body.fileReference.path, "/workspace/spec.md");
  assert.equal(calls[0].body.fileReference.relation, "test_plan");
});

test("dynamic request maps tool input to the authenticated collaboration HTTP contract", async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push({ path, body });
      return { confirmation: { confirmationId: "confirmation-a" } };
    }
  };

  const result = await callCollaborationDynamicTool(client, "corptie_collaboration_request", {
    session_agent_id: "agent-b",
    type: "change_request",
    title: "Update API",
    summary: "Add the endpoint",
    parent_task_id: "work_item:wrong-parent",
    context_id: "work_item:wrong-context"
  });

  assert.deepEqual(calls, [{
    path: "/internal/collaboration/task-confirmations",
    body: {
      sessionAgentId: "agent-b",
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

test("dynamic request rejects an empty success response instead of reporting coordination success", async () => {
  await assert.rejects(
    callCollaborationDynamicTool({ post: async () => ({}) }, "corptie_collaboration_request", {
      session_agent_id: "agent-b",
      type: "change_request",
      title: "Update API",
      summary: "Add the endpoint"
    }),
    (error) => error.code === "COLLABORATION_REQUEST_EMPTY_RESPONSE"
  );
});

test("dynamic request reports an already confirmed exact Session route as sent", async () => {
  const result = await callCollaborationDynamicTool({
    post: async () => ({
      confirmation: {
        confirmationId: "confirmation-trusted",
        status: "confirmed",
        taskId: "task-trusted"
      },
      routeAuthorization: "trusted_session_pair"
    })
  }, "corptie_collaboration_request", {
    recipient_session_id: "session:target",
    type: "question",
    title: "Follow up",
    summary: "Use the previously confirmed exact Session route."
  });

  assert.equal(result.confirmation.status, "confirmed");
  assert.equal(result.routeAuthorization, "trusted_session_pair");
  assert.equal(result.coordination.delivery, "push");
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

test("Session discovery maps an explicit peer Objective boundary", async () => {
  const calls = [];
  const client = {
    get: async (path, search) => {
      calls.push({ path, search });
      return { sessions: [] };
    }
  };

  await callCollaborationDynamicTool(client, "corptie_sessions_discover", {
    agent_id: "agent:marketcow",
    objective_id: "objective:marketcow",
    session_kind: "objectiveChat"
  });

  assert.deepEqual(calls, [{
    path: "/internal/collaboration/sessions",
    search: {
      agentId: "agent:marketcow",
      objectiveId: "objective:marketcow",
      workItemId: undefined,
      sessionKind: "objectiveChat"
    }
  }]);
});
