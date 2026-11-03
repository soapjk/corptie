import {
  agentIdSchema,
  COLLABORATION_RELATION_TYPES,
  sessionIdSchema,
  workIdSchema,
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
  description: "Optional existing Artifact to authorize for the new Task. The authenticated Session must already be able to read it, and it must belong to the same Work.",
  properties: {
    artifact_id: { type: "string", pattern: "^artifact:", description: "Existing Work Artifact identity." },
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

function tool(name, description, properties = {}, required = [], constraints = {}) {
  return {
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
      ...constraints
    }
  };
}

export const collaborationDynamicTools = Object.freeze([
  tool("corptie_collaboration_capabilities", "Read collaboration actions authorized for this exact authenticated Session. Session is the only actor and routing principal; Agent, Work, and Task are resources bound to it."),
  tool("corptie_sessions_discover", "Discover collaboration-receiving Sessions only after a direct recipient_session_name lookup returns RECIPIENT_SESSION_NOT_FOUND or RECIPIENT_SESSION_ALIAS_AMBIGUOUS. Without peer filters, results stay in the authenticated Work; explicit agent_id/work_id filters may return minimal peer-Work routing descriptors with Workspace and Provider details redacted.", {
    agent_id: agentIdSchema,
    work_id: workIdSchema,
    task_id: taskIdSchema,
    session_kind: { type: "string", enum: ["workChat", "worker", "assistantChat", "legacy"] }
  }),
  tool("corptie_sessions_get", "Read one visible logical Session without assuming that Sessions owned by the same Agent share context. Peer-Work results expose only the minimal collaboration route.", {
    session_id: sessionIdSchema
  }, ["session_id"]),
  tool("corptie_collaboration_tasks_list", "List Tasks visible to this Session. Work Chat sees its Work; Worker sees its bound Task and explicitly related collaboration Tasks."),
  tool("corptie_collaboration_tasks_get", "Read one Task visible to this Session.", {
    task_id: taskIdSchema
  }, ["task_id"]),
  tool("corptie_task_dispatch", "Quickly admit 1-10 asynchronous child instructions. The authenticated parent Session decides create versus reuse. Receipt means accepted, NOT started or completed. Return control to the user immediately; never poll waiting. Follow-up instructions use action=send with the original child Task id. Read authoritative Task/mailbox status rather than old chat status. Available in normal and coordination modes; only direct children, no grandchildren.", {
    items: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", additionalProperties: false,
      properties: { action: { type: "string", enum: ["create", "send"] }, task_id: taskIdSchema,
        text: { type: "string", minLength: 1, maxLength: 49152 }, idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
        creation: { type: "object", additionalProperties: false, properties: { title: { type: "string", minLength: 1 },
          description: taskFieldsSchema.description, acceptance_criteria: taskFieldsSchema.acceptance_criteria,
          verification_criteria: taskFieldsSchema.verification_criteria, priority: taskFieldsSchema.priority,
          agent_id: agentIdSchema, provider_id: { type: "string", minLength: 1 },
          artifact_reference: artifactReferenceSchema, file_reference: fileReferenceSchema }, required: ["title", "agent_id"] } },
      required: ["action", "text", "idempotency_key"],
      allOf: [{ if: { properties: { action: { const: "create" } } }, then: { required: ["creation"] }, else: { required: ["task_id"] } }] } }
  }, ["items"]),
  tool("corptie_task_dispatch_retry", "Retry failed child preparation with the original dispatch identity and frozen runtime settings. Only failed pre-mailbox preparation is retryable. Never replay a possibly accepted Provider instruction; inspect authoritative mailbox state instead.", {
    dispatch_id: { type: "string", minLength: 1 }
  }, ["dispatch_id"]),
  tool("corptie_collaboration_tasks_delete_child", "Autonomously request safe deletion of this Session's direct child Task without user confirmation. Asynchronous receipt; never poll. Running work, undelivered Git changes, or unpreserved Artifacts block safe deletion. This tool cannot force-discard data. Available regardless of coordination mode. Exact parent/child and authenticated Session checks remain mandatory.", {
    child_task_id: taskIdSchema, idempotency_key: { type: "string", minLength: 1, maxLength: 200 }
  }, ["child_task_id", "idempotency_key"]),
  tool("corptie_collaboration_tasks_create", "Create a Task and its companion Worker Session. Child creation is autonomous: the authenticated parent Session decides when and how many children to create, without explicit user creation requests, message evidence, confirmation or a total creation quota. Specify parent_task_id; no parent version is needed; Worker may target only its bound root Task, Work Chat a root in its Work. Prefer create_batch for 1-10 children per call. Independent Tasks (parent omitted/null) still require an explicit current direct-user request and authoritative turn evidence. Never use platform administration as a fallback.", {
    title: { type: "string", minLength: 1 },
    description: taskFieldsSchema.description,
    acceptance_criteria: taskFieldsSchema.acceptance_criteria,
    verification_criteria: taskFieldsSchema.verification_criteria,
    parent_task_id: { type: ["string", "null"], minLength: 1, description: "Explicit same-Work root Task; omit/null for independent creation." },
    expected_parent_resource_version: { type: "integer", minimum: 1, description: "Deprecated optional compatibility field; ignored for creation." },
    priority: taskFieldsSchema.priority,
    agent_id: agentIdSchema,
    provider_id: { type: "string", minLength: 1, description: "Optional explicit Provider override. Omit to use the user's Task creation defaults, including configured model and reasoning. Do not infer this from the calling Session's Provider." },
    artifact_reference: artifactReferenceSchema,
    file_reference: fileReferenceSchema,
    logical_session_id: { type: "string", minLength: 1, description: "Required only for independent Tasks: authoritative logical Session, not a Provider Session id." },
    user_message_event_id: { type: "string", minLength: 1, description: "Required only for independent Tasks: authoritative direct-user message event id." },
    user_message_sequence: { type: "integer", minimum: 1, description: "Required only for independent Tasks: direct-user message sequence." },
    turn_id: { type: "string", minLength: 1, description: "Required only for independent Tasks: authoritative current delivery/turn id." },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["title", "agent_id", "idempotency_key"], {
      allOf: [{ if: { required: ["parent_task_id"], properties: { parent_task_id: { type: "string" } } },
        then: {},
        else: {required:["logical_session_id","user_message_event_id","user_message_sequence","turn_id"]} }]
    }),
  tool("corptie_collaboration_tasks_create_batch", "Autonomously create 1-10 child Tasks and companion Worker Sessions in ONE call. The parent Session decides when and how many; no explicit user creation request, message/turn evidence, confirmation or total child quota is required. Worker may target only its bound root Task; Work Chat a root in its Work. No parent version is needed. Each item needs a stable idempotency_key; retry failed items with the SAME keys. Returns per-item success/failure and recovery; partial success is not rolled back. Never fall back to platform administration.", {
    parent_task_id: taskIdSchema,
    expected_parent_resource_version: { type: "integer", minimum: 1 },
    logical_session_id: { type: "string", minLength: 1 },
    user_message_event_id: { type: "string", minLength: 1 },
    user_message_sequence: { type: "integer", minimum: 1 },
    turn_id: { type: "string", minLength: 1 },
    items: { type: "array", minItems: 1, maxItems: 10, items: {
      type: "object", additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1 }, description: taskFieldsSchema.description,
        acceptance_criteria: taskFieldsSchema.acceptance_criteria, verification_criteria: taskFieldsSchema.verification_criteria,
        priority: taskFieldsSchema.priority, agent_id: agentIdSchema,
        provider_id: { type: "string", minLength: 1, description: "Optional override; omit to use configured creation defaults, not the caller's Provider." },
        artifact_reference: artifactReferenceSchema, file_reference: fileReferenceSchema,
        idempotency_key: { type: "string", minLength: 1, description: "Stable per-child key, preserved on retries and independent of batch position." }
      }, required: ["title", "agent_id", "idempotency_key"]
    } }
  }, ["parent_task_id", "items"]),
  tool("corptie_collaboration_tasks_relate", "Establish an allowed source/parent/dependency relation inside the authenticated Work; Worker relations must include its bound Task.", {
    task_id: taskIdSchema,
    target_task_id: taskIdSchema,
    relationship: { type: "string", enum: [...COLLABORATION_RELATION_TYPES] }
  }, ["task_id", "target_task_id", "relationship"]),
  tool("corptie_collaboration_tasks_share_artifact", "Grant one same-Work, explicitly related Task read-only access to an Artifact. Worker Sessions may share only Artifacts owned by their current Task; recipients cannot re-share received Artifacts.", {
    task_id: taskIdSchema,
    artifact_id: { type: "string", pattern: "^artifact:", description: "Artifact owned by the sharing Task, or any same-Work Artifact when called by Work Chat." },
    relation: { type: "string", enum: artifactRelations },
    required: { type: "boolean" },
    version_policy: { type: "string", enum: ["fixed", "latest_approved"] },
    version: { type: "integer", minimum: 1 }
  }, ["task_id", "artifact_id"]),
  tool("corptie_agents_discover", "Discover registered peer Agents and their capabilities. Do not use this tool to resolve an @Session name for Channel messaging.", {
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
  tool("corptie_collaboration_channel_open", "Send a first or follow-up message directly to an exact @Session name, opening or reusing its durable Channel. Pass recipient_session_name immediately without pre-discovery; the server resolves exact names and aliases (with or without @). Only if it returns structured not-found or ambiguity details should you discover Sessions and retry with recipient_session_id. Current direct parent/child Sessions in the same Work auto-authorize in BOTH directions, including child-first contact: call normally without asking for separate approval. The server checks current bindings and respects revocation; unrelated pairs retain ordinary authorization. A missing target may be created only through explicit user confirmation.", {
    recipient_session_name: { type: "string", minLength: 1, description: "Exact Session name or alias, optionally prefixed with @. Prefer this direct route before Session discovery." },
    recipient_session_id: sessionIdSchema,
    session_agent_id: { ...agentIdSchema, description: "Agent resource used only when Corptie must create the target Worker Session." },
    target_work_id: workIdSchema,
    task_id: taskIdSchema,
    title: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
    message_kind: { type: "string", enum: ["message", "question", "update"] },
    delivery_intent: { type: "string", enum: ["action_required", "response_required", "notification", "acknowledgement"], description: "Default action_required. Use action_required/response_required for requests. Notifications and acknowledgements are saved but do not wake the recipient; no routine receipt reply is needed." },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["body", "idempotency_key"]),
  tool("corptie_collaboration_channels_list", "List long-lived Channels containing this exact authenticated Session.", {
    status: { type: "array", items: { type: "string", enum: ["active", "revoked", "legacy_unresolved"] } },
    limit: { type: "integer", minimum: 1, maximum: 500 }
  }),
  tool("corptie_collaboration_channel_get", "Get one Channel and its latest messages in chronological order; use cursors to page history. Reading does not consume queued deliveries.", {
    channel_id: { type: "string", minLength: 1 },
    before_cursor: { type: "string", pattern: "^[1-9][0-9]*$" },
    after_cursor: { type: "string", pattern: "^[1-9][0-9]*$" },
    limit: { type: "integer", minimum: 1, maximum: 500 }
  }, ["channel_id"]),
  tool("corptie_collaboration_message_send", "Send a bidirectional message over an active Channel without creating task state or acceptance workflow.", {
    channel_id: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
    message_kind: { type: "string", enum: ["message", "question", "update"] },
    delivery_intent: { type: "string", enum: ["action_required", "response_required", "notification", "acknowledgement"], description: "Default action_required. Use action_required/response_required for requests. Notifications and acknowledgements are saved but do not wake the recipient; no routine receipt reply is needed." },
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
      agentId: input.agent_id, workId: input.work_id,
      taskId: input.task_id, sessionKind: input.session_kind
    }),
    corptie_sessions_get: () => client.get(`/internal/collaboration/sessions/${encodeURIComponent(input.session_id)}`),
    corptie_collaboration_tasks_list: () => client.get("/internal/collaboration/tasks"),
    corptie_collaboration_tasks_get: () => client.get(`/internal/collaboration/tasks/${encodeURIComponent(input.task_id)}`),
    corptie_task_dispatch: () => client.post("/internal/collaboration/tasks/dispatch", { items: input.items?.map(item => compact({
      action: item.action, taskId: item.task_id, text: item.text, idempotencyKey: item.idempotency_key,
      creation: item.creation ? taskCreationBody(item.creation) : undefined
    })) }),
    corptie_task_dispatch_retry: () => client.post("/internal/collaboration/tasks/dispatch/retry", { dispatchId: input.dispatch_id }),
    corptie_collaboration_tasks_delete_child: () => client.post("/internal/collaboration/tasks/delete-child", { childTaskId: input.child_task_id, idempotencyKey: input.idempotency_key }),
    corptie_collaboration_tasks_create: () => client.post("/internal/collaboration/tasks", taskCreationBody(input)),
    corptie_collaboration_tasks_create_batch: () => client.post("/internal/collaboration/tasks/batch", compact({
      parentTaskId: input.parent_task_id, expectedParentResourceVersion: input.expected_parent_resource_version,
      logicalSessionId: input.logical_session_id, userMessageEventId: input.user_message_event_id,
      userMessageSequence: input.user_message_sequence, turnId: input.turn_id,
      items: input.items.map(taskCreationBody)
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
      targetWorkId: input.target_work_id,
      taskId: input.task_id,
      title: input.title,
      body: input.body,
      messageKind: input.message_kind, deliveryIntent: input.delivery_intent,
      idempotencyKey: input.idempotency_key
    })),
    corptie_collaboration_channels_list: () => client.get("/internal/collaboration/channels", {
      status: input.status, limit: input.limit ?? 100
    }),
    corptie_collaboration_channel_get: () => client.get(
      `/internal/collaboration/channels/${encodeURIComponent(input.channel_id)}`,
      { limit: input.limit ?? 100, beforeCursor: input.before_cursor, afterCursor: input.after_cursor }
    ),
    corptie_collaboration_message_send: () => client.post(
      `/internal/collaboration/channels/${encodeURIComponent(input.channel_id)}/messages`,
      compact({ body: input.body, messageKind: input.message_kind, deliveryIntent: input.delivery_intent,
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
  const intent = value?.message?.deliveryIntent ?? value?.request?.message?.deliveryIntent ?? input.delivery_intent;
  const silent = ["notification", "acknowledgement"].includes(intent);
  return afterSendToolNames.has(name)
    ? {
        ...value,
        coordination: {
          delivery: pendingConfirmation ? "awaiting_user_confirmation" : silent ? "saved_without_wake" : "push",
          waitRequired: false,
          requiresUserAction: pendingConfirmation,
          nextAction: pendingConfirmation ? "end_current_turn" : "continue_current_turn",
          note: pendingConfirmation
            ? "Corptie will render and resolve confirmation programmatically. Do not write a confirmation message or continue this turn."
            : silent ? "Message saved without waking the recipient. Continue independent work; no receipt reply or polling is needed."
            : "Continue the current user-requested work when independent steps remain. Sending does not require ending the turn or waiting for a peer reply. Do not resend this message or poll; Corptie pushes peer messages into this Session's unified queue. End normally if the user's request is fulfilled."
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

function taskCreationBody(input) {
  return compact({ title: input.title, description: input.description,
    acceptanceCriteria: input.acceptance_criteria, verificationCriteria: input.verification_criteria,
    parentTaskId: input.parent_task_id, expectedParentResourceVersion: input.expected_parent_resource_version,
    priority: input.priority, agentId: input.agent_id, providerId: input.provider_id,
    artifactReference: input.artifact_reference ? { artifactId: input.artifact_reference.artifact_id,
      relation: input.artifact_reference.relation, required: input.artifact_reference.required,
      versionPolicy: input.artifact_reference.version_policy, version: input.artifact_reference.version } : undefined,
    fileReference: input.file_reference ? { path: input.file_reference.path,
      relation: input.file_reference.relation, required: input.file_reference.required } : undefined,
    logicalSessionId: input.logical_session_id, userMessageEventId: input.user_message_event_id,
    userMessageSequence: input.user_message_sequence, turnId: input.turn_id, idempotencyKey: input.idempotency_key });
}
