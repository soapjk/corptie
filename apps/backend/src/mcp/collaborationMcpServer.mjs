import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  agentIdSchema,
  COLLABORATION_RELATION_TYPES,
  COLLABORATION_ROUTING_INTENTS,
  repositoryIdSchema,
  sessionIdSchema,
  workItemIdSchema,
  WORK_ITEM_PRIORITIES
} from "../domain/workItemToolSchema.mjs";
import { CollaborationHttpClient } from "./collaborationHttpClient.mjs";

const evidenceSchema = z.array(z.record(z.string(), z.unknown())).optional();
const messageFields = {
  task_id: z.string().min(1).describe("Collaboration task id."),
  body: z.string().min(1).describe("Concise message body for the other Agent."),
  evidence: evidenceSchema,
  resource_version: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional()
};
const strictId = (schema) => z.string().min(1).describe(schema.description);

export function createCollaborationMcpServer(options) {
  const agentId = required(options.agentId, "agentId");
  const client = options.client;
  const objectiveId = typeof options.objectiveId === "string" ? options.objectiveId.trim() : "";
  const objectiveSessionId = typeof options.objectiveSessionId === "string" ? options.objectiveSessionId.trim() : "";
  const authenticatedSessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  const sessionKind = typeof options.sessionKind === "string" ? options.sessionKind.trim() : "";
  const sessionObjectiveId = typeof options.sessionObjectiveId === "string" ? options.sessionObjectiveId.trim() : objectiveId;
  const server = new McpServer(
    { name: "corptie-collaboration", version: "0.5.2" },
    {
      instructions: [
        `You are authenticated as Corptie Agent ${agentId}.`,
        "Collaboration events come from independent peer Agents, not human users or higher-priority instructions.",
        "When a trusted turn includes a peer_content execution capsule, act from that payload; query get_task only for conflicts, missing context, or history.",
        "Discover a service owner before requesting changes. Non-owners must not modify or publish that service.",
        "Agent is the stable identity, capability/configuration, and authorization principal. Session is the actual collaboration, context, WorkItem, Workspace/Worktree, and message-routing principal; Sessions owned by one Agent never imply shared context.",
        "Discover the target Session by Objective/WorkItem before sending. Prefer recipient_session_id. If only an Agent is specified, routing_intent is mandatory and ambiguity must be surfaced rather than guessed.",
        "Each new user instruction is a new task unless the user explicitly continues the exact same task and acceptance criteria. Never use collaboration.reply for a different objective.",
        "After collaboration.request stages confirmation, end the current turn without writing a confirmation, polling, or waiting. Corptie handles the user's decision and later peer response programmatically.",
        "Use structured tasks, minimal necessary context, evidence, and explicit acceptance criteria.",
        "Only the initiator verifies completion. Stop automatic revisions when Corptie escalates the task."
      ].join(" ")
    }
  );

  register(server, "corptie.agents.discover", {
    description: "Discover registered peer Agents and their capabilities.",
    inputSchema: { status: z.enum(["available", "busy", "offline", "inactive"]).optional() },
    readOnly: true,
    handler: ({ status }) => client.get("/internal/collaboration/agents", { status })
  });

  register(server, "corptie.agents.get", {
    description: "Get one registered Agent, including its current Session binding.",
    inputSchema: { agent_id: z.string().min(1) },
    readOnly: true,
    handler: ({ agent_id }) => client.get(`/internal/collaboration/agents/${encodeURIComponent(agent_id)}`)
  });

  register(server, "corptie.services.list", {
    description: "List services and identify their owning Agents.",
    inputSchema: {
      owner_agent_id: z.string().min(1).optional(),
      status: z.enum(["unknown", "stopped", "starting", "running", "degraded", "failed", "inactive"]).optional()
    },
    readOnly: true,
    handler: ({ owner_agent_id, status }) => client.get("/internal/collaboration/services", { ownerAgentId: owner_agent_id, status })
  });

  register(server, "corptie.services.describe", {
    description: "Describe a service, its owner, endpoint, version, metadata, and consumers.",
    inputSchema: { service_id: z.string().min(1) },
    readOnly: true,
    handler: ({ service_id }) => client.get(`/internal/collaboration/services/${encodeURIComponent(service_id)}`)
  });

  if (authenticatedSessionId) register(server, "corptie.collaboration.capabilities", {
    description: "Read collaboration actions authorized for this exact authenticated Session.",
    inputSchema: {}, readOnly: true,
    handler: () => client.get("/internal/collaboration/session-capabilities")
  });
  if (authenticatedSessionId) register(server, "corptie.sessions.discover", {
    description: "Discover receiving Sessions visible within the authenticated Objective/Agent scope, including stable Session/Agent identity, kind, lifecycle, route, Worktree, and capabilities.",
    inputSchema: {
      agent_id: strictId(agentIdSchema).optional(),
      work_item_id: strictId(workItemIdSchema).optional(),
      session_kind: z.enum(["objectiveChat", "worker", "assistantChat", "legacy"]).optional()
    }, readOnly: true,
    handler: ({ agent_id, work_item_id, session_kind }) => client.get("/internal/collaboration/sessions", {
      agentId: agent_id, workItemId: work_item_id, sessionKind: session_kind
    })
  });
  if (authenticatedSessionId) register(server, "corptie.sessions.get", {
    description: "Read one visible logical Session. Same-Agent Sessions are distinct contexts.",
    inputSchema: { session_id: strictId(sessionIdSchema) }, readOnly: true,
    handler: ({ session_id }) => client.get(`/internal/collaboration/sessions/${encodeURIComponent(session_id)}`)
  });
  if (sessionObjectiveId && ["objectiveChat", "worker"].includes(sessionKind)) register(server, "corptie.collaboration.work_items.list", {
    description: "List WorkItems visible to this authenticated Session.", inputSchema: {}, readOnly: true,
    handler: () => client.get("/internal/collaboration/work-items")
  });
  if (sessionObjectiveId && ["objectiveChat", "worker"].includes(sessionKind)) register(server, "corptie.collaboration.work_items.get", {
    description: "Read one WorkItem visible to this authenticated Session.",
    inputSchema: { work_item_id: strictId(workItemIdSchema) }, readOnly: true,
    handler: ({ work_item_id }) => client.get(`/internal/collaboration/work-items/${encodeURIComponent(work_item_id)}`)
  });
  if (sessionObjectiveId && ["objectiveChat", "worker"].includes(sessionKind)) register(server, "corptie.collaboration.work_items.create", {
    description: "Create an Objective-scoped collaboration WorkItem. Worker Sessions require an explicit delegated_subtask, depends_on, blocks, or review_of relation to their bound WorkItem.",
    inputSchema: {
      title: z.string().min(1), description: z.string().optional(), acceptance_criteria: z.string().optional(),
      priority: z.enum(WORK_ITEM_PRIORITIES).optional(), agent_id: strictId(agentIdSchema).optional(),
      main_workspace_id: strictId(repositoryIdSchema).optional(), parent_work_item_id: strictId(workItemIdSchema).optional(),
      source_work_item_id: strictId(workItemIdSchema).optional(),
      relationship: z.enum(COLLABORATION_RELATION_TYPES).optional(),
      idempotency_key: z.string().min(1)
    },
    handler: (input) => client.post("/internal/collaboration/work-items", {
      title: input.title, description: input.description, acceptanceCriteria: input.acceptance_criteria,
      priority: input.priority, agentId: input.agent_id, mainWorkspaceId: input.main_workspace_id,
      parentWorkItemId: input.parent_work_item_id, sourceWorkItemId: input.source_work_item_id,
      relationship: input.relationship, idempotencyKey: input.idempotency_key
    })
  });
  if (sessionObjectiveId && ["objectiveChat", "worker"].includes(sessionKind)) register(server, "corptie.collaboration.work_items.relate", {
    description: "Establish an allowed WorkItem relationship within the authenticated Objective.",
    inputSchema: {
      work_item_id: strictId(workItemIdSchema), target_work_item_id: strictId(workItemIdSchema),
      relationship: z.enum(COLLABORATION_RELATION_TYPES)
    },
    handler: ({ work_item_id, target_work_item_id, relationship }) => client.post("/internal/collaboration/work-item-relations", {
      workItemId: work_item_id, targetWorkItemId: target_work_item_id, relationship
    })
  });
  if (sessionObjectiveId && ["objectiveChat", "worker"].includes(sessionKind)) register(server, "corptie.collaboration.work_items.start", {
    description: "Start an authorized WorkItem through the Provider-neutral lifecycle with concurrency and idempotency controls.",
    inputSchema: {
      work_item_id: strictId(workItemIdSchema), agent_id: strictId(agentIdSchema).optional(), title: z.string().min(1).optional(),
      resource_version: z.string().min(1), idempotency_key: z.string().min(1)
    },
    handler: ({ work_item_id, agent_id, title, resource_version, idempotency_key }) => client.post(
      `/internal/collaboration/work-items/${encodeURIComponent(work_item_id)}/start`,
      { agentId: agent_id, title, resourceVersion: resource_version, idempotencyKey: idempotency_key }
    )
  });
  if (sessionObjectiveId && ["objectiveChat", "worker"].includes(sessionKind)) register(server, "corptie.collaboration.work_items.cancel", {
    description: "Safely cancel an authorized WorkItem while preserving its audit record; physical deletion is unavailable.",
    inputSchema: { work_item_id: strictId(workItemIdSchema), reason: z.string().min(1), resource_version: z.string().min(1) },
    handler: ({ work_item_id, reason, resource_version }) => client.post(
      `/internal/collaboration/work-items/${encodeURIComponent(work_item_id)}/cancel`,
      { reason, resourceVersion: resource_version }
    )
  });

  register(server, "corptie_list_workspaces", {
    description: "List Corptie's registered local Git worktrees, including opaque ids accepted by corptie_switch_workspace.",
    inputSchema: {},
    readOnly: true,
    handler: () => client.get("/internal/collaboration/workspaces")
  });

  register(server, "corptie_create_worktree", {
    description: "Create a validated Git worktree for the active repository. By default, Corptie schedules the logical Session to switch after the current turn completes.",
    inputSchema: {
      target_path: z.string().min(1).describe("Absolute local filesystem path for the new worktree."),
      branch: z.string().min(1).optional(),
      base_ref: z.string().min(1).optional(),
      create_branch: z.boolean().optional(),
      detach: z.boolean().optional(),
      switch_after_create: z.boolean().optional(),
      inventory_version: z.string().min(1).optional(),
      continuation_checkpoint: z.string().min(1).optional()
    },
    handler: (input) => client.post("/internal/collaboration/worktrees", input)
  });

  register(server, "corptie_switch_workspace", {
    description: "Schedule the active logical Session to switch to an existing registered worktree after the current turn completes.",
    inputSchema: {
      target_worktree_id: z.string().min(1).describe("Opaque worktree id from corptie_list_workspaces."),
      continuation_checkpoint: z.string().min(1).optional()
    },
    handler: (input) => client.post("/internal/collaboration/workspaces/switch", input)
  });

  if (sessionObjectiveId && ["objectiveChat", "worker"].includes(sessionKind)) register(server, "corptie.collaboration.request", {
    description: "Stage an Objective-to-Objective WorkItem question or change request for deterministic user confirmation. Resolve the recipient first, then call this tool immediately with the final fields; Corptie renders and handles confirmation without another Agent turn. The authenticated Agent represents the source Objective.",
    inputSchema: {
      recipient_session_name: z.string().min(1).optional(),
      recipient_session_id: strictId(sessionIdSchema).optional(),
      recipient_agent_id: strictId(agentIdSchema).optional(),
      routing_intent: z.enum(COLLABORATION_ROUTING_INTENTS).optional(),
      service_id: z.string().min(1).optional(),
      target_objective_id: z.string().min(1).optional(),
      work_item_id: z.string().min(1).optional(),
      type: z.enum(["question", "change_request"]),
      title: z.string().min(1),
      summary: z.string().min(1),
      acceptance_criteria: z.array(z.string().min(1)).default([]),
      evidence: evidenceSchema,
      resource_version: z.string().min(1).optional(),
      max_iterations: z.number().int().min(1).max(3).default(3),
      idempotency_key: z.string().min(1).optional(),
      parent_task_id: z.string().min(1).optional(),
      context_id: z.string().min(1).optional()
    },
    afterSend: true,
    handler: (input) => client.post("/internal/collaboration/task-confirmations", mapRequest(input))
  });

  register(server, "corptie.memory.search", {
    description:
      "Search the Corptie memory hub for relevant past context, preferences, decisions, or procedures, scoped to the current Session's bound Agent, Objective, and Work Item. Call this when starting a new work item, encountering unfamiliar context, or needing to recall previously established preferences or conventions. The intent should describe what you are trying to recall in plain language.",
    inputSchema: {
      intent: z.string().min(1).describe("Plain-language description of what you are trying to recall (e.g. 'coding conventions for this project' or 'the user's preferred commit message style').")
    },
    readOnly: true,
    handler: ({ intent }) => client.get("/internal/collaboration/memory/search", { intent })
  });

  register(server, "corptie_memory_search", {
    description: "Search active, non-revoked memories visible to the authenticated current Session. Empty intent returns a bounded high-confidence recall set.",
    inputSchema: {
      intent: z.string().optional().describe("What to recall. May be empty for high-confidence startup recall.")
    },
    readOnly: true,
    handler: ({ intent }) => client.get("/internal/collaboration/memory/search", { intent: intent ?? "" })
  });

  register(server, "corptie_memory_list", {
    description: "List memories manageable from the authenticated current Session.",
    inputSchema: {
      scope: z.enum(["agent", "objective", "work_item"]).optional(),
      include_revoked: z.boolean().optional()
    },
    readOnly: true,
    handler: ({ scope, include_revoked }) => client.get("/internal/collaboration/memory", {
      scope,
      includeRevoked: include_revoked ? "true" : undefined
    })
  });

  register(server, "corptie_memory_remember", {
    description: "Persist structured memory only when the user explicitly asks to remember it. Owner identity is derived from the authenticated current Session.",
    inputSchema: {
      content: z.string().min(1),
      kind: z.enum(["skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"]),
      scope: z.enum(["agent", "objective", "work_item"]).optional(),
      tags: z.array(z.string().min(1)).optional()
    },
    handler: (input) => client.post("/internal/collaboration/memory", input)
  });

  register(server, "corptie_memory_update", {
    description: "Correct a non-revoked memory manageable from the authenticated current Session without changing ownership or provenance.",
    inputSchema: {
      memory_id: z.string().min(1),
      content: z.string().min(1).optional(),
      tags: z.array(z.string().min(1)).optional()
    },
    handler: ({ memory_id, ...input }) => client.post(
      `/internal/collaboration/memory/${encodeURIComponent(memory_id)}/update`,
      input
    )
  });

  register(server, "corptie_memory_revoke", {
    description: "Revoke a memory while preserving provenance. Revoked memories stop search and injection; physical deletion is unavailable.",
    inputSchema: {
      memory_id: z.string().min(1),
      reason: z.string().min(1).optional()
    },
    handler: ({ memory_id, reason }) => client.post(
      `/internal/collaboration/memory/${encodeURIComponent(memory_id)}/revoke`,
      { reason }
    )
  });

  register(server, "corptie_skill_search", {
    description:
      "Search the compact index of Skills assigned to the authenticated Corptie Agent. Call this when a reusable workflow may help; results do not include full instructions.",
    inputSchema: {
      intent: z.string().min(1).describe("Plain-language description of the capability or workflow needed.")
    },
    readOnly: true,
    handler: ({ intent }) => client.get("/internal/collaboration/skills/search", { intent })
  });

  register(server, "corptie_skill_load", {
    description:
      "Load the complete SKILL.md instructions for one Skill returned by corptie_skill_search. Only Skills assigned to this Agent can be loaded.",
    inputSchema: {
      skill_id: z.string().min(1).describe("Opaque Skill id returned by corptie_skill_search.")
    },
    readOnly: true,
    handler: ({ skill_id }) => client.get(`/internal/collaboration/skills/${encodeURIComponent(skill_id)}`)
  });

  if (objectiveId) registerObjectiveChatTools(server, client, objectiveId, objectiveSessionId);

  register(server, "corptie_work_item_report_acceptance", {
    description:
      "Report a criterion-by-criterion acceptance assessment for the WorkItem bound to this Session. Call only after verification. A passed criterion requires reproducible evidence; Session completion alone is never evidence.",
    inputSchema: {
      results: z.array(z.object({
        criterion: z.string().min(1),
        verdict: z.enum(["passed", "failed", "unknown"]),
        evidence: z.array(z.object({
          summary: z.string().min(1),
          reference: z.string().min(1).describe(
            "A reproducible command, local artifact URI, or file/result locator that lets the user verify the evidence."
          )
        }).strict()).min(0)
      }).strict()).min(1).describe(
        "Results for every current WorkItem acceptance criterion, exactly once and in the original order."
      )
    },
    handler: ({ results }) => client.post("/internal/collaboration/work-items/acceptance", { results })
  });

  registerAction(server, client, "accept", "Accept a proposed task or resume requested revisions and begin working.", {
    task_id: z.string().min(1)
  });
  registerAction(server, client, "reject", "Reject a proposed task with a concrete reason.", {
    task_id: z.string().min(1),
    reason: z.string().min(1)
  });
  registerAction(server, client, "ask", "Ask the initiator for information required to decide or proceed.", messageFields);
  registerAction(server, client, "reply", "Reply within the exact scope of an existing task. Never use this tool for a new user instruction or changed acceptance criteria; create a new collaboration.request instead. A recipient reply to a question completes that question.", messageFields);

  register(server, "corptie.collaboration.submit_result", {
    description: "Submit a formal result Artifact to the initiator for verification.",
    inputSchema: {
      task_id: z.string().min(1),
      body: z.string().min(1),
      artifact: z.object({
        artifact_id: z.string().min(1).optional(),
        type: z.string().min(1),
        name: z.string().min(1),
        uri: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional()
      }),
      evidence: evidenceSchema,
      resource_version: z.string().min(1).optional(),
      idempotency_key: z.string().min(1).optional()
    },
    afterSend: true,
    handler: ({ task_id, resource_version, idempotency_key, artifact, ...input }) => client.post(
      actionPath(task_id, "submit-result"),
      {
        ...input,
        resourceVersion: resource_version,
        idempotencyKey: idempotency_key,
        artifact: {
          artifactId: artifact.artifact_id,
          type: artifact.type,
          name: artifact.name,
          uri: artifact.uri,
          metadata: artifact.metadata
        }
      }
    )
  });

  registerAction(server, client, "request_revision", "Report failed verification and request another iteration; Corptie escalates after iteration three.", messageFields, "request-revision");
  registerAction(server, client, "complete", "Confirm that the delivered result meets the acceptance criteria and complete the task.", messageFields);
  registerAction(server, client, "cancel", "Cancel a non-terminal task initiated by the authenticated Agent.", {
    task_id: z.string().min(1),
    reason: z.string().min(1)
  });

  register(server, "corptie.collaboration.get_task", {
    description: "Read compact context for the current task action. Request full history only for audit or debugging.",
    inputSchema: {
      task_id: z.string().min(1),
      include_history: z.boolean().default(false).describe("Include every message, Artifact, and event. Defaults to false.")
    },
    readOnly: true,
    handler: ({ task_id, include_history }) => client.get(
      `/internal/collaboration/tasks/${encodeURIComponent(task_id)}`,
      { includeHistory: include_history ? "true" : undefined }
    )
  });

  register(server, "corptie.collaboration.list_inbox", {
    description: "List collaboration tasks addressed to the authenticated Agent.",
    inputSchema: {
      status: z.array(z.enum(["proposed", "needs_information", "accepted", "working", "delivered", "verifying", "revision_requested", "completed", "rejected", "canceled", "escalated"])).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    },
    readOnly: true,
    handler: ({ status, limit }) => client.get("/internal/collaboration/inbox", { status, limit })
  });

  return server;
}

function registerObjectiveChatTools(server, client, objectiveId, sessionId) {
  const call = (tool, arguments_) => client.post("/internal/objective-chat/tool", {
    objectiveId, sessionId, tool, arguments: arguments_
  });
  register(server, "corptie_objective_context", {
    description: "Read the current Objective Chat scope, including Objective, WorkItems, Workspaces, and contributor Agents.",
    inputSchema: {}, readOnly: true,
    handler: () => call("corptie_objective_context", {})
  });
  register(server, "corptie_objective_agents_list", {
    description: "List contributor Agents eligible for work in this Objective.",
    inputSchema: {}, readOnly: true,
    handler: () => call("corptie_objective_agents_list", {})
  });
}

function registerAction(server, client, name, description, inputSchema, pathName = name) {
  register(server, `corptie.collaboration.${name}`, {
    description,
    inputSchema,
    afterSend: ["ask", "reply", "request_revision", "complete"].includes(name),
    handler: ({ task_id, resource_version, idempotency_key, ...body }) => client.post(
      actionPath(task_id, pathName),
      { ...body, resourceVersion: resource_version, idempotencyKey: idempotency_key }
    )
  });
}

function register(server, name, options) {
  server.registerTool(name, {
    description: options.description,
    inputSchema: options.inputSchema,
    annotations: {
      readOnlyHint: options.readOnly === true,
      destructiveHint: false,
      idempotentHint: options.readOnly === true,
      openWorldHint: false
    }
  }, async (input) => {
    try {
      const value = await options.handler(input);
      const data = options.afterSend
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
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ code: error.code ?? "COLLABORATION_ERROR", error: error.message }) }]
      };
    }
  });
}

function mapRequest(input) {
  return compact({
    recipientAgentId: input.recipient_agent_id,
    recipientSessionName: input.recipient_session_name,
    recipientSessionId: input.recipient_session_id,
    serviceId: input.service_id,
    routingIntent: input.routing_intent,
    targetObjectiveId: input.target_objective_id,
    workItemId: input.work_item_id,
    type: input.type,
    title: input.title,
    summary: input.summary,
    acceptanceCriteria: input.acceptance_criteria,
    evidence: input.evidence,
    resourceVersion: input.resource_version,
    maxIterations: input.max_iterations,
    idempotencyKey: input.idempotency_key,
    parentTaskId: input.parent_task_id,
    contextId: input.context_id
  });
}

function actionPath(taskId, action) {
  return `/internal/collaboration/tasks/${encodeURIComponent(taskId)}/actions/${action}`;
}

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function main() {
  const agentId = required(process.env.CORPTIE_AGENT_ID, "CORPTIE_AGENT_ID");
  const client = new CollaborationHttpClient({
    agentId,
    sessionScope: {
      sessionId: process.env.CORPTIE_SESSION_ID,
      objectiveId: process.env.CORPTIE_OBJECTIVE_ID,
      workItemId: process.env.CORPTIE_WORK_ITEM_ID
    }
  });
  const server = createCollaborationMcpServer({
    agentId,
    client,
    objectiveId: process.env.CORPTIE_OBJECTIVE_CHAT_ID,
    objectiveSessionId: process.env.CORPTIE_OBJECTIVE_CHAT_SESSION_ID,
    sessionId: process.env.CORPTIE_SESSION_ID,
    sessionKind: process.env.CORPTIE_SESSION_KIND,
    sessionObjectiveId: process.env.CORPTIE_OBJECTIVE_ID
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[corptie-collaboration-mcp] ${error.message}`);
    process.exitCode = 1;
  });
}
