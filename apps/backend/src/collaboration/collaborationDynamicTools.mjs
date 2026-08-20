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
    recipient_agent_id: { type: "string", minLength: 1 },
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
    idempotency_key: { type: "string", minLength: 1 },
    parent_task_id: { type: "string", minLength: 1 },
    context_id: { type: "string", minLength: 1 }
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
      idempotencyKey: input.idempotency_key,
      parentTaskId: input.parent_task_id,
      contextId: input.context_id
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
