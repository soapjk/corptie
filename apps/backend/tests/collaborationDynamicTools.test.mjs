import assert from "node:assert/strict";
import test from "node:test";
import {
  callCollaborationDynamicTool,
  collaborationDynamicTools
} from "../src/collaboration/collaborationDynamicTools.mjs";

test("dynamic collaboration tools are top-level, eagerly loaded, unique, and provider-safe", () => {
  const names = collaborationDynamicTools.map((entry) => entry.name);
  assert.equal(names.length, 17);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("corptie_agents_discover"));
  assert.ok(names.includes("corptie_collaboration_channel_open"));
  assert.ok(names.includes("corptie_collaboration_message_send"));
  assert.ok(names.includes("corptie_sessions_discover"));
  assert.ok(names.includes("corptie_collaboration_tasks_create"));
  assert.ok(names.includes("corptie_collaboration_tasks_share_artifact"));
  assert.equal(names.includes("corptie_collaboration_tasks_start"), false);
  assert.equal(names.includes("corptie_collaboration_tasks_cancel"), false);
  assert.equal(names.some((name) => name.includes("tasks_delete") || name.includes("tasks_update")), false);
  for (const entry of collaborationDynamicTools) {
    assert.equal(entry.type, "function");
    assert.equal(entry.deferLoading, false);
    assert.ok(entry.name.length < 64);
    assert.equal(entry.inputSchema.type, "object");
    assert.equal(entry.inputSchema.additionalProperties, false);
  }
  assert.equal(names.some((name) => name.includes("work_item")), false);
  const createTask = collaborationDynamicTools.find((entry) => entry.name === "corptie_collaboration_tasks_create");
  assert.equal(Object.hasOwn(createTask.inputSchema.properties, "parent_task_id"), false);
  assert.equal(Object.hasOwn(createTask.inputSchema.properties, "source_task_id"), false);
  assert.equal(createTask.inputSchema.properties.artifact_reference.required[0], "artifact_id");
  assert.equal(createTask.inputSchema.properties.file_reference.required[0], "path");
  assert.deepEqual(createTask.inputSchema.required, ["title", "agent_id", "idempotency_key"]);
});

test("dynamic Task creation maps assignment and Provider for automatic startup", async () => {
  const calls = [];
  const client = {
    sessionScope: { sessionId: "session:source" },
    post: async (path, body) => { calls.push({ path, body }); return { status: "ready" }; }
  };
  await callCollaborationDynamicTool(client, "corptie_collaboration_tasks_create", {
    title: "Worker",
    agent_id: "agent:worker",
    provider_id: "claude-sdk",
    idempotency_key: "create:one"
  });
  assert.deepEqual(calls, [{
    path: "/internal/collaboration/tasks",
    body: {
      title: "Worker",
      agentId: "agent:worker",
      providerId: "claude-sdk",
      idempotencyKey: "create:one"
    }
  }]);
});

test("dynamic Artifact sharing maps a read-only Task reference request", async () => {
  const calls = [];
  const client = { post: async (path, body) => { calls.push({ path, body }); return { access: "read_only" }; } };
  const result = await callCollaborationDynamicTool(client, "corptie_collaboration_tasks_share_artifact", {
    task_id: "task:target", artifact_id: "artifact:owned",
    relation: "handoff", required: true, version_policy: "fixed", version: 1
  });
  assert.deepEqual(calls, [{
    path: "/internal/collaboration/task-artifact-references",
    body: {
      taskId: "task:target", artifactId: "artifact:owned",
      relation: "handoff", required: true, versionPolicy: "fixed", version: 1
    }
  }]);
  assert.equal(result.access, "read_only");
});

test("dynamic Task creation maps Artifact and file reference contracts without dropping fields", async () => {
  const calls = [];
  const client = { post: async (path, body) => { calls.push({ path, body }); return { task: { id: "task:new" } }; } };
  await callCollaborationDynamicTool(client, "corptie_collaboration_tasks_create", {
    title: "Referenced", agent_id: "agent:worker", provider_id: "provider:test",
    idempotency_key: "create:referenced",
    artifact_reference: {
      artifact_id: "artifact:spec", relation: "implementation_spec", required: true,
      version_policy: "fixed", version: 2
    }
  });
  assert.deepEqual(calls[0], {
    path: "/internal/collaboration/tasks",
    body: {
      title: "Referenced",
      agentId: "agent:worker",
      providerId: "provider:test",
      artifactReference: {
        artifactId: "artifact:spec", relation: "implementation_spec", required: true,
        versionPolicy: "fixed", version: 2
      },
      idempotencyKey: "create:referenced"
    }
  });
  calls.length = 0;
  await callCollaborationDynamicTool(client, "corptie_collaboration_tasks_create", {
    title: "File", idempotency_key: "create:file",
    agent_id: "agent:worker",
    file_reference: { path: "/workspace/spec.md", relation: "test_plan", required: false }
  });
  assert.equal(calls[0].body.fileReference.path, "/workspace/spec.md");
  assert.equal(calls[0].body.fileReference.relation, "test_plan");
});

test("dynamic Channel open maps tool input to the authenticated collaboration HTTP contract", async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push({ path, body });
      return { request: { requestId: "channel-request-a", status: "pending" } };
    }
  };

  const result = await callCollaborationDynamicTool(client, "corptie_collaboration_channel_open", {
    session_agent_id: "agent-b",
    target_work_id: "work-b",
    title: "Peer Session",
    body: "Add the endpoint",
    message_kind: "question",
    idempotency_key: "open-a"
  });

  assert.deepEqual(calls, [{
    path: "/internal/collaboration/channel-requests",
    body: {
      sessionAgentId: "agent-b",
      targetWorkId: "work-b",
      title: "Peer Session",
      body: "Add the endpoint",
      messageKind: "question",
      idempotencyKey: "open-a"
    }
  }]);
  assert.equal(result.coordination.delivery, "awaiting_user_confirmation");
  assert.equal(result.coordination.nextAction, "end_current_turn");
});

test("dynamic Channel open rejects an empty success response instead of reporting coordination success", async () => {
  await assert.rejects(
    callCollaborationDynamicTool({ post: async () => ({}) }, "corptie_collaboration_channel_open", {
      session_agent_id: "agent-b",
      target_work_id: "work-b",
      body: "Add the endpoint",
      idempotency_key: "open-empty"
    }),
    (error) => error.code === "CHANNEL_REQUEST_EMPTY_RESPONSE"
  );
});

test("dynamic Channel open reports an active exact Session route as sent", async () => {
  const result = await callCollaborationDynamicTool({
    post: async () => ({
      request: { status: "sent", channel: { channelId: "channel:trusted" } }
    })
  }, "corptie_collaboration_channel_open", {
    recipient_session_id: "session:target",
    body: "Use the active exact Session Channel.",
    idempotency_key: "follow-up"
  });

  assert.equal(result.request.status, "sent");
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

test("Session discovery maps an explicit peer Work boundary", async () => {
  const calls = [];
  const client = {
    get: async (path, search) => {
      calls.push({ path, search });
      return { sessions: [] };
    }
  };

  await callCollaborationDynamicTool(client, "corptie_sessions_discover", {
    agent_id: "agent:marketcow",
    work_id: "work:marketcow",
    session_kind: "workChat"
  });

  assert.deepEqual(calls, [{
    path: "/internal/collaboration/sessions",
    search: {
      agentId: "agent:marketcow",
      workId: "work:marketcow",
      taskId: undefined,
      sessionKind: "workChat"
    }
  }]);
});
