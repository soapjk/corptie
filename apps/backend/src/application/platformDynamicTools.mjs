import { COLLABORATION_RELATION_TYPES, workItemPatchSchema } from "../domain/workItemToolSchema.mjs";

function tool(name, description, properties, required = [], schemaExtensions = {}) {
  return Object.freeze({
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
      ...schemaExtensions
    }
  });
}

const id = (description) => ({ type: "string", minLength: 1, description });
const openObject = { type: "object", additionalProperties: true };
const nullableString = { type: ["string", "null"] };
const stringArray = { type: "array", items: { type: "string" } };
const artifactVisibility = { type: "string", enum: ["objective_private", "work_item_private", "session_private", "repository_tracked"] };
const artifactRelation = { type: "string", enum: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"] };
const objectivePatch = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    idealState: { type: "string" },
    status: { type: "string", minLength: 1 },
    budgetConfig: { type: "object" },
    priority: nullableString,
    targetDate: nullableString,
    tags: stringArray,
    workspaceIds: stringArray,
    relatedObjectiveIds: stringArray,
    contributorAgentIds: stringArray
  },
  additionalProperties: false
};
export const platformDynamicTools = Object.freeze([
  tool(
    "corptie_platform_capabilities",
    "List the Corptie product operations available to the built-in platform Assistant.",
    {}
  ),
  tool(
    "corptie_platform_agents_manage",
    "List, inspect, create, edit, or delete Corptie Agents. The built-in platform Assistant itself is protected.",
    {
      action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
      agent_id: id("Agent id for get, update, or delete."),
      name: { type: "string", minLength: 1 },
      description: { type: "string" },
      role: { type: "string", enum: ["assistant", "independentContributor"] },
      system_prompt: { type: "string" },
      capabilities: { type: "array", items: { type: "string" } },
      skill_ids: { type: "array", items: { type: "string" } },
      work_dir: { type: "string" },
      avatar_path: { type: ["string", "null"] }
    },
    ["action"]
  ),
  tool(
    "corptie_platform_objectives_manage",
    "List, inspect, create, edit, or delete Objectives using Corptie's product rules.",
    {
      action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
      objective_id: id("Objective id for get, update, or delete."),
      name: { type: "string", minLength: 1 },
      patch: objectivePatch
    },
    ["action"]
  ),
  tool(
    "corptie_platform_work_items_manage",
    "List, inspect, create, edit, delete, or manage dependencies for WorkItems.",
    {
      action: {
        type: "string",
        enum: ["list", "get", "create", "update", "delete", "dependencies", "add_dependency", "remove_dependency"]
      },
      work_item_id: id("WorkItem id."),
      target_work_item_id: id("Dependency target WorkItem id."),
      objective_id: id("Owning Objective id for create or list filtering."),
      title: { type: "string", minLength: 1 },
      dependency_type: { type: "string", enum: [...COLLABORATION_RELATION_TYPES] },
      patch: workItemPatchSchema
    },
    ["action"],
    {
      allOf: [
        {
          if: { properties: { action: { const: "get" } }, required: ["action"] },
          then: { required: ["work_item_id"] }
        },
        {
          if: { properties: { action: { const: "create" } }, required: ["action"] },
          then: { required: ["objective_id", "title"] }
        },
        {
          if: { properties: { action: { const: "update" } }, required: ["action"] },
          then: { required: ["work_item_id", "patch"] }
        },
        {
          if: { properties: { action: { const: "delete" } }, required: ["action"] },
          then: { required: ["work_item_id"] }
        },
        {
          if: { properties: { action: { const: "dependencies" } }, required: ["action"] },
          then: { required: ["work_item_id"] }
        },
        {
          if: {
            properties: { action: { enum: ["add_dependency", "remove_dependency"] } },
            required: ["action"]
          },
          then: { required: ["work_item_id", "target_work_item_id"] }
        }
      ]
    }
  ),
  tool(
    "corptie_platform_sessions_manage",
    "Operate Sessions through the shared Agent Provider lifecycle, including conversation, lifecycle, approvals, changes, models, usage, permissions, presentation, and deletion.",
    {
      action: {
        type: "string",
        enum: [
          "list", "get", "create", "send", "interrupt", "resume", "disconnect", "rename", "archive", "pin",
          "delete", "clear", "restart", "respond_to_approval", "manage_turn_changes", "list_models",
          "read_account_usage", "read_session_usage", "switch_model", "switch_reasoning", "update_permissions"
        ]
      },
      session_id: id("Session id for all operations except list and create."),
      agent_id: id("Agent that owns a newly created Session."),
      provider_id: id("Agent Provider for a newly created Session."),
      work_item_id: id("Optional WorkItem for a new Worker Session."),
      title: { type: "string" },
      prompt: { type: "string" },
      message: { type: "string", minLength: 1 },
      archived: { type: "boolean" },
      pinned: { type: "boolean" },
      include_archived: { type: "boolean" },
      approval: openObject,
      turn_id: id("Provider turn id for managing proposed changes."),
      change_action: { type: "string", enum: ["apply", "revert"] },
      model_id: { type: "string", minLength: 1 },
      reasoning_level: { type: "string", minLength: 1 },
      permissions: openObject
    },
    ["action"]
  ),
  tool(
    "corptie_platform_artifacts_manage",
    "Manage the complete lifecycle of Artifacts in an explicitly selected Objective. Every mutation is attributed to the authenticated platform Assistant Session.",
    {
      action: { type: "string", enum: ["list", "get", "search", "create", "import", "publish", "reference", "revoke_reference", "acknowledge_reference", "change_visibility", "supersede", "revoke", "verify_integrity", "export", "backup", "restore"] },
      objective_id: id("Explicit target Objective id."),
      artifact_id: { type: "string", pattern: "^artifact:" },
      reference_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 }, summary: { type: "string" }, content: { type: "string" },
      query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 65536 },
      offset: { type: "integer", minimum: 0 }, version: { type: "integer", minimum: 1 },
      visibility: artifactVisibility, bound_work_item_id: id("Same-Objective WorkItem id."),
      bound_session_id: id("Same-Objective Session id."), repository_locator: { type: "string", minLength: 1 },
      mime_type: { type: "string", minLength: 1 }, approval_status: { type: "string", enum: ["draft", "approved"] },
      work_item_id: id("Same-Objective WorkItem reference target."), session_id: id("Same-Objective Session reference target."),
      relation: artifactRelation, required: { type: "boolean" }, version_policy: { type: "string", enum: ["fixed", "latest_approved"] },
      reason: { type: "string", minLength: 1 }, source_path: { type: "string", minLength: 1 },
      destination_path: { type: "string", minLength: 1 }, confirmation_id: id("Server-issued confirmation record id."),
      confirmed_repository_write: { type: "boolean" }, confirmed_overwrite: { type: "boolean" },
      include_revoked: { type: "boolean" }, idempotency_key: { type: "string", minLength: 1, maxLength: 200 }
    },
    ["action", "objective_id"]
  ),
  tool(
    "corptie_platform_collaboration_manage",
    "Discover exact Session actors, create target WorkItems and Worker Sessions, and stage formal Session-to-Session collaboration for real user confirmation.",
    {
      action: { type: "string", enum: ["discover_sessions", "get_session", "create_work_item", "start_worker", "request"] },
      session_id: id("Exact logical or Provider Session id."), objective_id: id("Explicit target Objective id."),
      agent_id: id("Agent resource used to configure a Worker Session; never a message recipient."),
      work_item_id: id("Target WorkItem id."), title: { type: "string", minLength: 1 }, description: { type: "string" },
      acceptance_criteria: { type: "array", items: { type: "string" } }, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      provider_id: id("Provider resource for Worker Session creation."), summary: { type: "string", minLength: 1 },
      type: { type: "string", enum: ["question", "change_request"] }, max_iterations: { type: "integer", minimum: 1 },
      idempotency_key: { type: "string", minLength: 1, maxLength: 200 }
    },
    ["action"]
  )
]);

export async function callPlatformDynamicTool(platformOperationService, input = {}) {
  if (!platformOperationService) {
    const error = new Error("Corptie platform operations are unavailable.");
    error.code = "PLATFORM_OPERATIONS_UNAVAILABLE";
    throw error;
  }
  return platformOperationService.execute({
    actorId: input.actorId ?? input.agentId,
    sessionId: input.metadata?.sessionId,
    tool: input.tool,
    arguments: input.arguments ?? {}
  });
}
