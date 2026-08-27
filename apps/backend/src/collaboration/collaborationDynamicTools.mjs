import {
  agentIdSchema,
  COLLABORATION_RELATION_TYPES,
  COLLABORATION_ROUTING_INTENTS,
  repositoryIdSchema,
  sessionIdSchema,
  objectiveIdSchema,
  workItemFieldsSchema,
  workItemIdSchema
} from "../domain/workItemToolSchema.mjs";

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
  body: { type: "string", minLength: 1, description: "Concise message body for the other Agent." },
  evidence: evidenceSchema,
  resource_version: { type: "string", minLength: 1 },
  idempotency_key: { type: "string", minLength: 1 }
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
  tool("corptie_collaboration_capabilities", "Read collaboration actions authorized for this exact authenticated Session. Agent is the identity/authorization principal; Session is the context and routing principal."),
  tool("corptie_sessions_discover", "Discover collaboration-receiving Sessions. Without peer filters, results stay in the authenticated Objective; explicit agent_id/objective_id filters may return minimal peer-Objective routing descriptors with Workspace and Provider details redacted.", {
    agent_id: agentIdSchema,
    objective_id: objectiveIdSchema,
    work_item_id: workItemIdSchema,
    session_kind: { type: "string", enum: ["objectiveChat", "worker", "assistantChat", "legacy"] }
  }),
  tool("corptie_sessions_get", "Read one visible logical Session without assuming that Sessions owned by the same Agent share context. Peer-Objective results expose only the minimal collaboration route.", {
    session_id: sessionIdSchema
  }, ["session_id"]),
  tool("corptie_collaboration_work_items_list", "List WorkItems visible to this Session. Objective Chat sees its Objective; Worker sees its bound WorkItem and explicitly related collaboration WorkItems."),
  tool("corptie_collaboration_work_items_get", "Read one WorkItem visible to this Session.", {
    work_item_id: workItemIdSchema
  }, ["work_item_id"]),
  tool("corptie_collaboration_work_items_create", "Create an Objective-scoped collaboration WorkItem. Objective Chat may create top-level or child work; Worker requires an explicit allowed relation to its bound WorkItem. Actor/Objectives/source Session are runtime-derived.", {
    title: { type: "string", minLength: 1 },
    description: workItemFieldsSchema.description,
    acceptance_criteria: workItemFieldsSchema.acceptance_criteria,
    priority: workItemFieldsSchema.priority,
    agent_id: agentIdSchema,
    main_workspace_id: repositoryIdSchema,
    parent_work_item_id: workItemIdSchema,
    source_work_item_id: workItemIdSchema,
    relationship: { type: "string", enum: [...COLLABORATION_RELATION_TYPES] },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["title", "idempotency_key"]),
  tool("corptie_collaboration_work_items_relate", "Establish an allowed source/parent/dependency relation inside the authenticated Objective; Worker relations must include its bound WorkItem.", {
    work_item_id: workItemIdSchema,
    target_work_item_id: workItemIdSchema,
    relationship: { type: "string", enum: [...COLLABORATION_RELATION_TYPES] }
  }, ["work_item_id", "target_work_item_id", "relationship"]),
  tool("corptie_collaboration_work_items_start", "Start an authorized collaboration WorkItem through the Provider-neutral Session/Worktree lifecycle. Returns a staged receipt and never reports start success without an actual Session binding.", {
    work_item_id: workItemIdSchema,
    agent_id: agentIdSchema,
    title: { type: "string", minLength: 1 },
    resource_version: { type: "string", minLength: 1 },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["work_item_id", "resource_version", "idempotency_key"]),
  tool("corptie_collaboration_work_items_cancel", "Safely cancel an authorized collaboration WorkItem while preserving its audit record; physical deletion is unavailable.", {
    work_item_id: workItemIdSchema,
    reason: { type: "string", minLength: 1 },
    resource_version: { type: "string", minLength: 1 }
  }, ["work_item_id", "reason", "resource_version"]),
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
  tool("corptie_collaboration_request", "Stage an Objective-to-Objective WorkItem question or change request for deterministic user confirmation. Resolve the recipient first, then call this tool immediately with the final fields; Corptie renders and handles confirmation without another Agent turn.", {
    recipient_session_name: { type: "string", minLength: 1 },
    recipient_session_id: sessionIdSchema,
    recipient_agent_id: { type: "string", minLength: 1 },
    routing_intent: { type: "string", enum: [...COLLABORATION_ROUTING_INTENTS], description: "Required when recipient_session_id is omitted. Choose from task context. A final collaboration target is always the target WorkItem's active Worker Session; Objective Chat only orchestrates creation. Reuse requires work_item_id, otherwise Corptie creates the WorkItem Session." },
    service_id: { type: "string", minLength: 1 },
    target_objective_id: { type: "string", minLength: 1, description: "Target Objective. Defaults to the recipient's current Objective or compatibility Objective." },
    work_item_id: { type: "string", minLength: 1, description: "Existing target-Objective WorkItem to use instead of creating one." },
    type: { type: "string", enum: ["question", "change_request"] },
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    acceptance_criteria: { type: "array", items: { type: "string", minLength: 1 } },
    evidence: evidenceSchema,
    resource_version: { type: "string", minLength: 1 },
    max_iterations: { type: "integer", minimum: 1, maximum: 3 },
    idempotency_key: { type: "string", minLength: 1 }
  }, ["type", "title", "summary"]),
  tool("corptie_collaboration_accept", "Accept a proposed task or resume requested revisions and begin working.", {
    task_id: { type: "string", minLength: 1 }
  }, ["task_id"]),
  tool("corptie_collaboration_reject", "Reject a proposed task with a concrete reason.", {
    task_id: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 }
  }, ["task_id", "reason"]),
  tool("corptie_collaboration_ask", "Ask the initiator for information required to decide or proceed.", messageProperties, ["task_id", "body"]),
  tool("corptie_collaboration_reply", "Reply within the exact scope of an existing task. Never use this tool for a new user instruction or changed acceptance criteria.", messageProperties, ["task_id", "body"]),
  tool("corptie_collaboration_submit_result", "Submit a formal result Artifact to the initiator for verification.", {
    ...messageProperties,
    artifact: {
      type: "object",
      properties: {
        artifact_id: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        uri: { type: "string", minLength: 1 },
        metadata: { type: "object", additionalProperties: true }
      },
      required: ["type", "name", "uri"],
      additionalProperties: false
    }
  }, ["task_id", "body", "artifact"]),
  tool("corptie_collaboration_request_revision", "Report failed verification and request another iteration; Corptie escalates after iteration three.", messageProperties, ["task_id", "body"]),
  tool("corptie_collaboration_complete", "Confirm that the delivered result meets the acceptance criteria and complete the task.", messageProperties, ["task_id", "body"]),
  tool("corptie_collaboration_cancel", "Cancel a non-terminal task initiated by the authenticated Agent.", {
    task_id: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 }
  }, ["task_id", "reason"]),
  tool("corptie_collaboration_get_task", "Read compact context for the current task action. Request full history only for audit or debugging.", {
    task_id: { type: "string", minLength: 1 },
    include_history: { type: "boolean", description: "Include every message, Artifact, and event. Defaults to false." }
  }, ["task_id"]),
  tool("corptie_collaboration_list_inbox", "List collaboration tasks addressed to the authenticated Agent.", {
    status: { type: "array", items: { type: "string", enum: taskStatuses } },
    limit: { type: "integer", minimum: 1, maximum: 500 }
  })
]);

export async function callCollaborationDynamicTool(client, name, input = {}) {
  const handlers = {
    corptie_collaboration_capabilities: () => client.get("/internal/collaboration/session-capabilities"),
    corptie_sessions_discover: () => client.get("/internal/collaboration/sessions", {
      agentId: input.agent_id, objectiveId: input.objective_id,
      workItemId: input.work_item_id, sessionKind: input.session_kind
    }),
    corptie_sessions_get: () => client.get(`/internal/collaboration/sessions/${encodeURIComponent(input.session_id)}`),
    corptie_collaboration_work_items_list: () => client.get("/internal/collaboration/work-items"),
    corptie_collaboration_work_items_get: () => client.get(`/internal/collaboration/work-items/${encodeURIComponent(input.work_item_id)}`),
    corptie_collaboration_work_items_create: () => client.post("/internal/collaboration/work-items", compact({
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptance_criteria,
      priority: input.priority,
      agentId: input.agent_id,
      mainWorkspaceId: input.main_workspace_id,
      parentWorkItemId: input.parent_work_item_id,
      sourceWorkItemId: input.source_work_item_id,
      relationship: input.relationship,
      idempotencyKey: input.idempotency_key
    })),
    corptie_collaboration_work_items_relate: () => client.post("/internal/collaboration/work-item-relations", {
      workItemId: input.work_item_id,
      targetWorkItemId: input.target_work_item_id,
      relationship: input.relationship
    }),
    corptie_collaboration_work_items_start: () => client.post(`/internal/collaboration/work-items/${encodeURIComponent(input.work_item_id)}/start`, compact({
      agentId: input.agent_id, title: input.title, resourceVersion: input.resource_version, idempotencyKey: input.idempotency_key
    })),
    corptie_collaboration_work_items_cancel: () => client.post(`/internal/collaboration/work-items/${encodeURIComponent(input.work_item_id)}/cancel`, {
      reason: input.reason, resourceVersion: input.resource_version
    }),
    corptie_agents_discover: () => client.get("/internal/collaboration/agents", { status: input.status }),
    corptie_agents_get: () => client.get(`/internal/collaboration/agents/${encodeURIComponent(input.agent_id)}`),
    corptie_services_list: () => client.get("/internal/collaboration/services", {
      ownerAgentId: input.owner_agent_id,
      status: input.status
    }),
    corptie_services_describe: () => client.get(`/internal/collaboration/services/${encodeURIComponent(input.service_id)}`),
    corptie_collaboration_request: () => client.post("/internal/collaboration/task-confirmations", compact({
      recipientAgentId: input.recipient_agent_id,
      recipientSessionName: input.recipient_session_name,
      recipientSessionId: input.recipient_session_id,
      routingIntent: input.routing_intent,
      serviceId: input.service_id,
      targetObjectiveId: input.target_objective_id,
      workItemId: input.work_item_id,
      type: input.type,
      title: input.title,
      summary: input.summary,
      acceptanceCriteria: input.acceptance_criteria ?? [],
      evidence: input.evidence,
      resourceVersion: input.resource_version,
      maxIterations: input.max_iterations ?? 3,
      idempotencyKey: input.idempotency_key
    })),
    corptie_collaboration_accept: () => action(client, input, "accept"),
    corptie_collaboration_reject: () => action(client, input, "reject"),
    corptie_collaboration_ask: () => action(client, input, "ask"),
    corptie_collaboration_reply: () => action(client, input, "reply"),
    corptie_collaboration_submit_result: () => action(client, input, "submit-result", {
      artifact: {
        artifactId: input.artifact?.artifact_id,
        type: input.artifact?.type,
        name: input.artifact?.name,
        uri: input.artifact?.uri,
        metadata: input.artifact?.metadata
      }
    }),
    corptie_collaboration_request_revision: () => action(client, input, "request-revision"),
    corptie_collaboration_complete: () => action(client, input, "complete"),
    corptie_collaboration_cancel: () => action(client, input, "cancel"),
    corptie_collaboration_get_task: () => client.get(
      `/internal/collaboration/tasks/${encodeURIComponent(input.task_id)}`,
      { includeHistory: input.include_history ? "true" : undefined }
    ),
    corptie_collaboration_list_inbox: () => client.get("/internal/collaboration/inbox", {
      status: input.status,
      limit: input.limit ?? 100
    })
  };
  const handler = handlers[name];
  if (!handler) {
    const error = new Error(`Unsupported Corptie collaboration tool: ${name}`);
    error.code = "UNSUPPORTED_COLLABORATION_TOOL";
    throw error;
  }
  const value = await handler();
  if (name === "corptie_collaboration_request") requireStagedConfirmation(value);
  return afterSendToolNames.has(name)
    ? {
        ...value,
        coordination: {
          delivery: value?.confirmation ? "awaiting_user_confirmation" : "push",
          waitRequired: false,
          nextAction: "end_current_turn",
          note: value?.confirmation
            ? "Corptie will render and resolve confirmation programmatically. Do not write a confirmation message or continue this turn."
            : "Do not poll or wait. Corptie will push the peer response into this Agent's unified queue."
        }
      }
    : value;
}

function requireStagedConfirmation(value) {
  if (typeof value?.confirmation?.confirmationId === "string" && value.confirmation.confirmationId.trim()) return value;
  const error = new Error("Corptie collaboration request did not return a staged confirmation ID.");
  error.code = "COLLABORATION_REQUEST_EMPTY_RESPONSE";
  throw error;
}

const afterSendToolNames = new Set([
  "corptie_collaboration_request",
  "corptie_collaboration_ask",
  "corptie_collaboration_reply",
  "corptie_collaboration_submit_result",
  "corptie_collaboration_request_revision",
  "corptie_collaboration_complete"
]);

function action(client, input, actionName, extra = {}) {
  const { task_id, resource_version, idempotency_key, artifact: _artifact, ...body } = input;
  return client.post(
    `/internal/collaboration/tasks/${encodeURIComponent(task_id)}/actions/${actionName}`,
    compact({
      ...body,
      ...extra,
      resourceVersion: resource_version,
      idempotencyKey: idempotency_key
    })
  );
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
