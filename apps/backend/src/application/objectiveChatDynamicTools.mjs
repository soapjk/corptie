function tool(name, description, properties = {}, required = []) {
  return Object.freeze({
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
}

const id = (description) => ({ type: "string", minLength: 1, description });
export const objectiveChatDynamicTools = Object.freeze([
  tool("corptie_objective_context", "Read the current Objective Chat scope. Mutating Task operations use the strict corptie_collaboration_tasks_* Session-scoped tools."),
  tool("corptie_objective_agents_list", "List contributor Agents in this Objective. Discover their actual receiving Sessions before routing collaboration.")
]);

export function callObjectiveChatDynamicTool(service, input = {}) {
  if (!service) throw coded("OBJECTIVE_CHAT_UNAVAILABLE", "Objective Chat operations are unavailable.");
  return service.execute(input);
}

export class ObjectiveChatOperationService {
  constructor(options = {}) {
    this.store = options.store;
    this.objectiveService = options.objectiveService;
    this.contextService = options.contextService;
    this.workSessionStartApplicationService = options.workSessionStartApplicationService;
    this.defaultProviderId = options.defaultProviderId;
    if (!this.store || !this.objectiveService || !this.contextService
      || typeof this.workSessionStartApplicationService?.start !== "function" || !this.defaultProviderId) {
      throw new TypeError("ObjectiveChatOperationService requires store, objectiveService, contextService, and WorkSessionStartApplicationService.");
    }
  }

  async execute(input = {}) {
    const objectiveId = scopedObjectiveId(input.metadata);
    const args = input.arguments ?? {};
    switch (input.tool) {
      case "corptie_objective_context": return this.contextService.build(objectiveId);
      case "corptie_objective_update": return this.objectiveService.updateObjective(
        objectiveId,
        this.#objectivePatch(objectiveId, object(args.patch, "patch"))
      );
      case "corptie_objective_agents_list": return this.#agents(objectiveId);
      case "corptie_objective_tasks_manage": return this.#tasks(objectiveId, args);
      case "corptie_objective_task_start": {
        return this.workSessionStartApplicationService.start({
          taskId: text(args.task_id, "task_id"),
          assigneeAgentId: text(args.agent_id, "agent_id"),
          expectedTaskVersion: positiveInteger(args.resource_version, "resource_version"),
          providerId: optionalText(args.provider_id) ?? this.defaultProviderId,
          title: optionalText(args.title),
          idempotencyKey: text(args.idempotency_key, "idempotency_key"),
          sourceSessionId: text(input.metadata.sessionId, "source_session_id")
        });
      }
      default: throw coded("HOST_TOOL_UNSUPPORTED", `Unsupported Objective Chat tool: ${input.tool}`);
    }
  }

  #agents(objectiveId) {
    const objective = this.objectiveService.getObjective(objectiveId);
    const contributors = new Set(objective.contributorAgentIds);
    return this.store.listAgents().filter((agent) => contributors.has(agent.agentId)).map((agent) => ({
      agentId: agent.agentId, name: agent.name, role: agent.role,
      description: agent.description, status: agent.status,
      isContributor: true,
      canStartTask: agent.role === "independentContributor"
    }));
  }

  #tasks(objectiveId, args) {
    switch (text(args.action, "action")) {
      case "list": return this.objectiveService.listTasksByObjective(objectiveId);
      case "get": return this.#task(objectiveId, text(args.task_id, "task_id"));
      case "create": return this.objectiveService.createTask({
        ...this.#taskPatch(objectiveId, object(args.patch ?? {}, "patch")), objectiveId, title: text(args.title, "title")
      });
      case "update": {
        const item = this.#task(objectiveId, text(args.task_id, "task_id"));
        return this.objectiveService.updateTask(item.id, this.#taskPatch(objectiveId, object(args.patch, "patch")));
      }
      case "delete": {
        const item = this.#task(objectiveId, text(args.task_id, "task_id"));
        this.objectiveService.deleteTask(item.id);
        return { deleted: true };
      }
      default: throw coded("INVALID_ACTION", `Unsupported Task action: ${args.action}`);
    }
  }

  #task(objectiveId, taskId) {
    const item = this.objectiveService.getTask(taskId);
    if (item.objective_id !== objectiveId) throw coded("TASK_OUTSIDE_OBJECTIVE", "Task is outside this Objective Chat scope.");
    return item;
  }

  #objectivePatch(objectiveId, patch) {
    if (Array.isArray(patch.contributorAgentIds)) {
      for (const id of patch.contributorAgentIds) {
        const agent = this.store.getAgent(text(id, "contributorAgentIds[]"));
        if (!agent) throw coded("AGENT_NOT_FOUND", `Contributor Agent not found: ${id}`);
      }
    }
    if (Array.isArray(patch.workspaceIds)) {
      for (const id of patch.workspaceIds) {
        if (!this.store.getGitRepository(text(id, "workspaceIds[]"))) {
          throw coded("WORKSPACE_NOT_FOUND", `Workspace repository not found: ${id}`);
        }
      }
    }
    if (Array.isArray(patch.relatedObjectiveIds)) {
      for (const id of patch.relatedObjectiveIds) {
        const relatedId = text(id, "relatedObjectiveIds[]");
        if (relatedId === objectiveId || !this.store.getObjective(relatedId)) {
          throw coded("RELATED_OBJECTIVE_NOT_FOUND", `Related Objective not found or invalid: ${relatedId}`);
        }
      }
    }
    return patch;
  }

  #taskPatch(objectiveId, patch) {
    const objective = this.objectiveService.getObjective(objectiveId);
    if (patch.mainAgentId != null) {
      const agentId = text(patch.mainAgentId, "mainAgentId");
      const agent = this.store.getAgent(agentId);
      if (!agent) throw coded("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
      if (agent.role !== "independentContributor" || !objective.contributorAgentIds.includes(agentId)) {
        throw coded("AGENT_OUTSIDE_OBJECTIVE", "Task Agent must be an Independent Contributor attached to this Objective.");
      }
    }
    if (patch.mainWorkspaceId != null) {
      const workspaceId = text(patch.mainWorkspaceId, "mainWorkspaceId");
      if (!objective.workspaceIds.includes(workspaceId) || !this.store.getGitRepository(workspaceId)) {
        throw coded("WORKSPACE_OUTSIDE_OBJECTIVE", "Task Workspace must be attached to this Objective.");
      }
    }
    return patch;
  }
}

function scopedObjectiveId(metadata) {
  if (metadata?.sessionKind !== "objectiveChat") throw coded("OBJECTIVE_CHAT_SCOPE_REQUIRED", "Objective Chat scope is required.");
  return text(metadata.objectiveId, "objectiveId");
}
function text(value, field) { const result = typeof value === "string" ? value.trim() : ""; if (!result) throw coded("INVALID_INPUT", `${field} is required.`); return result; }
function optionalText(value) { const result = typeof value === "string" ? value.trim() : ""; return result || null; }
function positiveInteger(value, field) { const result = Number(value); if (!Number.isInteger(result) || result < 1) throw coded("TASK_VERSION_CONFLICT", `${field} must be a positive integer.`); return result; }
function object(value, field) { if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("INVALID_INPUT", `${field} must be an object.`); return value; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
