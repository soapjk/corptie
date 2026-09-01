import {
  agentIdSchema,
  COLLABORATION_RELATION_TYPES,
  repositoryIdSchema,
  sessionIdSchema,
  objectiveIdSchema,
  taskFieldsSchema,
  taskIdSchema
} from "../domain/taskToolSchema.mjs";

const evidenceSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true }
};
const taskStatuses = [
  "proposed",
  "needs_information",
  "accepted",
  "working",
  "delivered",
  "verifying",
  "revision_requested",
  "completed",
  "rejected",
  "canceled",
  "escalated"
];
const messageProperties = {
  task_id: { type: "string", minLength: 1, description: "Collaboration task id." },
  body: { type: "string", minLength: 1, description: "Concise message body for the peer Session." },
  evidence: evidenceSchema,
  resource_version: { type: "string", minLength: 1 },
  idempotency_key: { type: "string", minLength: 1 }
};
const artifactRelations = [
  "implementation_spec", "security_requirement", "test_plan", "research_evidence",
  "handoff", "acceptance_evidence"
];
const artifactReferenceSchema = {
  type: "object",
  description: "Optional existing Artifact to authorize for the new Task. The authenticated Session must already be able to read it, and it must belong to the same Objective.",
  properties: {
    artifact_id: { type: "string", pattern: "^artifact:", description: "Existing Objective Artifact identity." },
    relation: { type: "string", enum: artifactRelations },
    required: { type: "boolean" },
    version_policy: { type: "string", enum: ["fixed", "latest_approved"] },
    version: { type: "integer", minimum: 1 }
  },
  required: ["artifact_id"],
  additionalProperties: false
};
const fileReferenceSchema = {
  type: "object",
  description: "Optional readable regular file inside the authenticated Session's active Workspace to reference from the new Task. The file is not copied.",
  properties: {
    path: { type: "string", minLength: 1, description: "Absolute path inside the active Session Workspace." },
    relation: { type: "string", enum: artifactRelations },
    required: { type: "boolean" }
  },
  required: ["path"],
  additionalProperties: false
};

function tool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  };
}

export const collaborationDynamicTools = Object.freeze([
  tool("corptie_collaboration_capabilities", "Read collaboration actions authorized for this exact authenticated Session. Session is the only actor and routing principal; Agent, Objective, and Task are resources bound to it."),
  tool("corptie_sessions_discover", "Discover collaboration-receiving Sessions. Without peer filters, results stay in the authenticated Objective; explicit agent_id/objective_id filters may return minimal peer-Objective routing descriptors with Workspace and Provider details redacted.", {
    agent_id: agentIdSchema,
    objective_id: objectiveIdSchema,
    task_id: taskIdSchema,
    session_kind: { type: "string", enum: ["objectiveChat", "worker", "assistantChat", "legacy"] }
  }),
  tool("corptie_sessions_get", "Read one visible logical Session without assuming that Sessions owned by the same Agent share context. Peer-Objective results expose only the minimal collaboration route.", {
    session_id: sessionIdSchema
  }, ["session_id"]),
  tool("corptie_collaboration_tasks_list", "List Tasks visible to this Session. Objective Chat sees its Objective; Worker sees its bound Task and explicitly related collaboration Tasks."),
  tool("corptie_collaboration_tasks_get", "Read one Task visible to this Session.", {
    task_id: taskIdSchema
  }, ["task_id"]),
  tool("corptie_collaboration_tasks_create", "Create an independent Objective-scoped Task and record this Session as its creation origin. Creation never makes it a child or subtask of another Task.", {
    title: { type: "string", minLength: 1 },
    description: taskFieldsSchema.description,
    acceptance_criteria: taskFieldsSchema.acceptance_criteria,
    priority: taskFieldsSchema.priority,
    agent_id: agentIdSchema,
    main_workspace_id: repositoryIdSchema,
    artifact_reference: artifactReferenceSchema,
    file_reference: fileReferenceSchema,
    idempotency_key: { type: "string", minLength: 1 }
  }, ["title", "idempotency_key"]),
  tool("corptie_collaboration_tasks_relate", "Establish an allowed source/parent/dependency relation inside the authenticated Objective; Worker relations must include its bound Task.", {
    task_id: taskIdSchema,
    target_task_id: taskIdSchema,
    relationship: { type: "string", enum: [...COLLABORATION_RELATION_TYPES] }
  }, ["task_id", "target_task_id", "relationship"]),
  tool("corptie_collaboration_tasks_share_artifact", "Grant one same-Objective, explicitly related Task read-only access to an Artifact. Worker Sessions may share only Artifacts owned by their current Task; recipients cannot re-share received Artifacts.", {
    task_id: taskIdSchema,
    artifact_id: { type: "string", pattern: "^artifact:", description: "Artifact owned by the sharing Task, or any same-Objective Artifact when called by Objective Chat." },
    relation: { type: "string", enum: artifactRelations },
    required: { type: "boolean" },
    version_policy: { type: "string", enum: ["fixed", "latest_approved"] },
    version: { type: "integer", minimum: 1 }
  }, ["task_id", "artifact_id"]),
  tool("corptie_collaboration_tasks_start", "Start an authorized collaboration Task through the Provider-neutral Session/Worktree lifecycle. Returns a staged receipt and never reports start success without an actual Session binding.", {
    task_id: taskIdSchema,
    agent_id: agentIdSchema,
    title: { type: "string", minLength: 1 },
    resource_version: { type: "string", minLength: 1 },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["task_id", "resource_version", "idempotency_key"]),
  tool("corptie_agents_discover", "Discover registered peer Agents and their capabilities.", {
    status: { type: "string", enum: ["available", "unavailable"] }
  }),
  tool("corptie_agents_get", "Get one registered Agent, including its current Session binding.", {
    agent_id: { type: "string", minLength: 1 }
  }, ["agent_id"]),
  tool("corptie_services_list", "List services and identify their owning Agents.", {
    owner_agent_id: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["unknown", "stopped", "starting", "running", "degraded", "failed", "inactive"] }
  }),
  tool("corptie_services_describe", "Describe a service, its owner, endpoint, version, metadata, and consumers.", {
    service_id: { type: "string", minLength: 1 }
  }, ["service_id"]),
  tool("corptie_collaboration_channel_open", "Open or reuse a durable, user-authorized, bidirectional Channel between two exact logical Sessions and send its first message. If the target Session does not exist, one confirmation may authorize target Task creation, target Session creation, Channel activation, and delivery.", {
    recipient_session_name: { type: "string", minLength: 1 },
    recipient_session_id: sessionIdSchema,
    session_agent_id: { ...agentIdSchema, description: "Agent resource used only when Corptie must create the target Worker Session." },
    target_objective_id: objectiveIdSchema,
    task_id: taskIdSchema,
    title: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
    message_kind: { type: "string", enum: ["message", "question", "update"] },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["body", "idempotency_key"]),
  tool("corptie_collaboration_channels_list", "List long-lived Channels containing this exact authenticated Session.", {
    status: { type: "array", items: { type: "string", enum: ["active", "revoked", "legacy_unresolved"] } },
    limit: { type: "integer", minimum: 1, maximum: 500 }
  }),
  tool("corptie_collaboration_channel_get", "Get one Channel and its recent messages.", {
    channel_id: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 500 }
  }, ["channel_id"]),
  tool("corptie_collaboration_message_send", "Send a bidirectional message over an active Channel without creating task state or acceptance workflow.", {
    channel_id: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
    message_kind: { type: "string", enum: ["message", "question", "update"] },
    in_reply_to_message_id: { type: "string", minLength: 1 },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["channel_id", "body", "idempotency_key"]),
  tool("corptie_collaboration_channel_revoke", "Revoke a Channel for both Session endpoints while preserving its history.", {
    channel_id: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 }
  }, ["channel_id", "reason"])
]);

export async function callCollaborationDynamicTool(client, name, input = {}) {
  const handlers = {
    corptie_collaboration_capabilities: () => client.get("/internal/collaboration/session-capabilities"),
    corptie_sessions_discover: () => client.get("/internal/collaboration/sessions", {
      agentId: input.agent_id, objectiveId: input.objective_id,
      taskId: input.task_id, sessionKind: input.session_kind
    }),
    corptie_sessions_get: () => client.get(`/internal/collaboration/sessions/${encodeURIComponent(input.session_id)}`),
    corptie_collaboration_tasks_list: () => client.get("/internal/collaboration/tasks"),
    corptie_collaboration_tasks_get: () => client.get(`/internal/collaboration/tasks/${encodeURIComponent(input.task_id)}`),
    corptie_collaboration_tasks_create: () => client.post("/internal/collaboration/tasks", compact({
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptance_criteria,
      priority: input.priority,
      agentId: input.agent_id,
      mainWorkspaceId: input.main_workspace_id,
      artifactReference: input.artifact_reference ? {
        artifactId: input.artifact_reference.artifact_id,
        relation: input.artifact_reference.relation,
        required: input.artifact_reference.required,
        versionPolicy: input.artifact_reference.version_policy,
        version: input.artifact_reference.version
      } : undefined,
      fileReference: input.file_reference ? {
        path: input.file_reference.path,
        relation: input.file_reference.relation,
        required: input.file_reference.required
      } : undefined,
      idempotencyKey: input.idempotency_key
    })),
    corptie_collaboration_tasks_relate: () => client.post("/internal/collaboration/task-relations", {
      taskId: input.task_id,
      targetTaskId: input.target_task_id,
      relationship: input.relationship
    }),
    corptie_collaboration_tasks_share_artifact: () => client.post("/internal/collaboration/task-artifact-references", compact({
      taskId: input.task_id,
      artifactId: input.artifact_id,
      relation: input.relation,
      required: input.required,
      versionPolicy: input.version_policy,
      version: input.version
    })),
    corptie_collaboration_tasks_start: () => client.post(`/internal/collaboration/tasks/${encodeURIComponent(input.task_id)}/start`, compact({
      agentId: input.agent_id, title: input.title, resourceVersion: input.resource_version, idempotencyKey: input.idempotency_key
    })),
    corptie_agents_discover: () => client.get("/internal/collaboration/agents", { status: input.status }),
    corptie_agents_get: () => client.get(`/internal/collaboration/agents/${encodeURIComponent(input.agent_id)}`),
    corptie_services_list: () => client.get("/internal/collaboration/services", {
      ownerAgentId: input.owner_agent_id,
      status: input.status
    }),
    corptie_services_describe: () => client.get(`/internal/collaboration/services/${encodeURIComponent(input.service_id)}`),
    corptie_collaboration_channel_open: () => client.post("/internal/collaboration/channel-requests", compact({
      sessionAgentId: input.session_agent_id,
      recipientSessionName: input.recipient_session_name,
      recipientSessionId: input.recipient_session_id,
      targetObjectiveId: input.target_objective_id,
      taskId: input.task_id,
      title: input.title,
      body: input.body,
      messageKind: input.message_kind,
      idempotencyKey: input.idempotency_key
    })),
    corptie_collaboration_channels_list: () => client.get("/internal/collaboration/channels", {
      status: input.status, limit: input.limit ?? 100
    }),
    corptie_collaboration_channel_get: () => client.get(
      `/internal/collaboration/channels/${encodeURIComponent(input.channel_id)}`,
      { limit: input.limit ?? 100 }
    ),
    corptie_collaboration_message_send: () => client.post(
      `/internal/collaboration/channels/${encodeURIComponent(input.channel_id)}/messages`,
      compact({ body: input.body, messageKind: input.message_kind,
        inReplyToMessageId: input.in_reply_to_message_id, idempotencyKey: input.idempotency_key })
    ),
    corptie_collaboration_channel_revoke: () => client.post(
      `/internal/collaboration/channels/${encodeURIComponent(input.channel_id)}/revoke`,
      { reason: input.reason }
    )
  };
  const handler = handlers[name];
  if (!handler) {
    const error = new Error(`Unsupported Corptie collaboration tool: ${name}`);
    error.code = "UNSUPPORTED_COLLABORATION_TOOL";
    throw error;
  }
  const value = await handler();
  if (name === "corptie_collaboration_channel_open") requireChannelRequestReceipt(value);
  const pendingConfirmation = value?.request?.status === "pending";
  return afterSendToolNames.has(name)
    ? {
        ...value,
        coordination: {
          delivery: pendingConfirmation ? "awaiting_user_confirmation" : "push",
          waitRequired: false,
          nextAction: "end_current_turn",
          note: pendingConfirmation
            ? "Corptie will render and resolve confirmation programmatically. Do not write a confirmation message or continue this turn."
            : "Do not poll or wait. Corptie will push the peer response into this Agent's unified queue."
        }
      }
    : value;
}

function requireChannelRequestReceipt(value) {
  if (value?.request?.status === "sent" && value.request.channel?.channelId) return value;
  if (typeof value?.request?.requestId === "string" && value.request.requestId.trim()) return value;
  const error = new Error("Corptie Channel request did not return a durable receipt.");
  error.code = "CHANNEL_REQUEST_EMPTY_RESPONSE";
  throw error;
}

const afterSendToolNames = new Set([
  "corptie_collaboration_channel_open",
  "corptie_collaboration_message_send"
]);

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
