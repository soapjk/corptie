function tool(name, description, properties, required = []) {
  return Object.freeze({
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
  });
}

const id = (description) => ({ type: "string", minLength: 1, description });
const openObject = { type: "object", additionalProperties: true };
const nullableString = { type: ["string", "null"] };
const stringArray = { type: "array", items: { type: "string" } };
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
const workItemPatch = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    acceptanceCriteria: { type: "string" },
    priority: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    mainWorkspaceId: nullableString,
    mainAgentId: nullableString
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
      dependency_type: { type: "string" },
      patch: workItemPatch
    },
    ["action"]
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
    tool: input.tool,
    arguments: input.arguments ?? {}
  });
}
