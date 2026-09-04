import { COLLABORATION_RELATION_TYPES, taskPatchSchema } from "../domain/taskToolSchema.mjs";

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
const artifactVisibility = { type: "string", enum: ["work_private", "task_private", "session_private", "repository_tracked"] };
const artifactRelation = { type: "string", enum: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"] };
const workPatch = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    status: { type: "string", enum: ["active", "archived"] },
    profile: { type: "string", enum: ["general", "software", "office", "data", "design"] },
    tags: stringArray,
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
    "corptie_platform_works_manage",
    "List, inspect, create, edit, or delete Works using Corptie's product rules.",
    {
      action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
      work_id: id("Work id for get, update, or delete."),
      name: { type: "string", minLength: 1 },
      patch: workPatch
    },
    ["action"]
  ),
  tool(
    "corptie_platform_tasks_manage",
    "List, inspect, create, edit, delete, or manage dependencies for Tasks.",
    {
      action: {
        type: "string",
        enum: ["list", "get", "create", "update", "delete", "dependencies", "add_dependency", "remove_dependency"]
      },
      task_id: id("Task id."),
      target_task_id: id("Dependency target Task id."),
      work_id: id("Owning Work id for create or list filtering."),
      title: { type: "string", minLength: 1 },
      agent_id: id("Assigned Independent Contributor for create."),
      provider_id: id("Optional Provider for the companion Worker Session."),
      idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
      dependency_type: { type: "string", enum: [...COLLABORATION_RELATION_TYPES] },
      patch: taskPatchSchema
    },
    ["action"],
    {
      allOf: [
        {
          if: { properties: { action: { const: "get" } }, required: ["action"] },
          then: { required: ["task_id"] }
        },
        {
          if: { properties: { action: { const: "create" } }, required: ["action"] },
          then: { required: ["work_id", "title", "agent_id", "idempotency_key"] }
        },
        {
          if: { properties: { action: { const: "update" } }, required: ["action"] },
          then: { required: ["task_id", "patch"] }
        },
        {
          if: { properties: { action: { const: "delete" } }, required: ["action"] },
          then: { required: ["task_id"] }
        },
        {
          if: { properties: { action: { const: "dependencies" } }, required: ["action"] },
          then: { required: ["task_id"] }
        },
        {
          if: {
            properties: { action: { enum: ["add_dependency", "remove_dependency"] } },
            required: ["action"]
          },
          then: { required: ["task_id", "target_task_id"] }
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
      task_id: id("Optional Task for a new Worker Session."),
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
    "Manage the complete lifecycle of Artifacts in an explicitly selected Work. Every mutation is attributed to the authenticated platform Assistant Session.",
    {
      action: { type: "string", enum: ["list", "get", "search", "create", "update_metadata", "import", "publish", "reference", "revoke_reference", "acknowledge_reference", "change_visibility", "supersede", "revoke", "restore_artifact", "verify_integrity", "export", "backup", "restore"] },
      work_id: id("Explicit target Work id."),
      artifact_id: { type: "string", pattern: "^artifact:" },
      reference_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 }, summary: { type: "string" }, content: { type: "string" },
      query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 65536 },
      offset: { type: "integer", minimum: 0 }, version: { type: "integer", minimum: 1 },
      visibility: artifactVisibility, bound_task_id: id("Same-Work Task id."),
      scope: { type: "string", enum: ["work", "task"] }, kind: { type: "string" },
      category_path: { type: "string" }, tags: stringArray, aliases: stringArray, keywords: stringArray,
      kinds: stringArray, category_prefix: { type: "string" },
      bound_session_id: id("Same-Work Session id."), repository_locator: { type: "string", minLength: 1 },
      mime_type: { type: "string", minLength: 1 }, approval_status: { type: "string", enum: ["draft", "approved"] },
      task_id: id("Same-Work Task reference target."), session_id: id("Same-Work Session reference target."),
      relation: artifactRelation, required: { type: "boolean" }, version_policy: { type: "string", enum: ["fixed", "latest_approved"] },
      reason: { type: "string", minLength: 1 }, source_path: { type: "string", minLength: 1 },
      destination_path: { type: "string", minLength: 1 }, confirmation_id: id("Server-issued confirmation record id."),
      confirmed_repository_write: { type: "boolean" }, confirmed_overwrite: { type: "boolean" },
      include_revoked: { type: "boolean" }, idempotency_key: { type: "string", minLength: 1, maxLength: 200 }
    },
    ["action", "work_id"]
  ),
  tool(
    "corptie_platform_collaboration_manage",
    "Discover exact Session actors, create a target Task with its Worker Session in one operation, and stage formal Session-to-Session collaboration for real user confirmation.",
    {
      action: { type: "string", enum: ["discover_sessions", "get_session", "create_task", "start_worker", "request"] },
      session_id: id("Exact logical or Provider Session id."), work_id: id("Explicit target Work id."),
      agent_id: id("Agent resource used to configure a Worker Session; never a message recipient."),
      task_id: id("Target Task id."), title: { type: "string", minLength: 1 }, description: { type: "string" },
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
