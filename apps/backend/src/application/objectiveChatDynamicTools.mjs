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
const patch = { type: "object", additionalProperties: true };

export const objectiveChatDynamicTools = Object.freeze([
  tool("corptie_objective_context", "Read the current Objective Chat scope, including its Objective, WorkItems, Workspaces, and contributor Agents."),
  tool("corptie_objective_update", "Update fields on the Objective bound to this Objective Chat.", { patch }, ["patch"]),
  tool("corptie_objective_work_items_manage", "Create, list, inspect, update, or delete WorkItems within the Objective bound to this chat.", {
    action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
    work_item_id: id("WorkItem id within this Objective."),
    title: { type: "string", minLength: 1 },
    patch
  }, ["action"]),
  tool("corptie_objective_agents_list", "List Agents attached to this Objective. Independent Contributors can be selected for WorkItem execution."),
  tool("corptie_objective_work_item_start", "Request execution of a WorkItem in this Objective through the shared Agent Provider lifecycle.", {
    work_item_id: id("WorkItem id within this Objective."),
    agent_id: id("Independent Contributor Agent id."),
    title: { type: "string" }
  }, ["work_item_id", "agent_id"])
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
    this.startWorkItem = options.startWorkItem;
    if (!this.store || !this.objectiveService || !this.contextService || typeof this.startWorkItem !== "function") {
      throw new TypeError("ObjectiveChatOperationService requires store, objectiveService, contextService, and startWorkItem().");
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
      case "corptie_objective_work_items_manage": return this.#workItems(objectiveId, args);
      case "corptie_objective_work_item_start": {
        const workItem = this.#workItem(objectiveId, text(args.work_item_id, "work_item_id"));
        const agent = this.store.getAgent(text(args.agent_id, "agent_id"));
        if (!agent) throw coded("AGENT_NOT_FOUND", "Agent not found.");
        if (agent.role !== "independentContributor") throw coded("AGENT_NOT_INDEPENDENT_CONTRIBUTOR", "A Worker Session requires an Independent Contributor.");
        const objective = this.objectiveService.getObjective(objectiveId);
        if (!objective.contributorAgentIds.includes(agent.agentId)) {
          throw coded("AGENT_OUTSIDE_OBJECTIVE", "Agent is not a contributor to this Objective.");
        }
        return this.startWorkItem({ workItem, agent, title: optionalText(args.title) });
      }
      default: throw coded("HOST_TOOL_UNSUPPORTED", `Unsupported Objective Chat tool: ${input.tool}`);
    }
  }

  #agents(objectiveId) {
    const objective = this.objectiveService.getObjective(objectiveId);
    const contributors = new Set(objective.contributorAgentIds);
    return this.store.listAgents().filter((agent) => contributors.has(agent.agentId)).map((agent) => ({
      agentId: agent.agentId, name: agent.name, role: agent.role, provider: agent.provider,
      description: agent.description, status: agent.status,
      isContributor: true,
      canStartWorkItem: agent.role === "independentContributor"
    }));
  }

  #workItems(objectiveId, args) {
    switch (text(args.action, "action")) {
      case "list": return this.objectiveService.listWorkItemsByObjective(objectiveId);
      case "get": return this.#workItem(objectiveId, text(args.work_item_id, "work_item_id"));
      case "create": return this.objectiveService.createWorkItem({
        ...this.#workItemPatch(objectiveId, object(args.patch ?? {}, "patch")), objectiveId, title: text(args.title, "title")
      });
      case "update": {
        const item = this.#workItem(objectiveId, text(args.work_item_id, "work_item_id"));
        return this.objectiveService.updateWorkItem(item.id, this.#workItemPatch(objectiveId, object(args.patch, "patch")));
      }
      case "delete": {
        const item = this.#workItem(objectiveId, text(args.work_item_id, "work_item_id"));
        this.objectiveService.deleteWorkItem(item.id);
        return { deleted: true };
      }
      default: throw coded("INVALID_ACTION", `Unsupported WorkItem action: ${args.action}`);
    }
  }

  #workItem(objectiveId, workItemId) {
    const item = this.objectiveService.getWorkItem(workItemId);
    if (item.objective_id !== objectiveId) throw coded("WORK_ITEM_OUTSIDE_OBJECTIVE", "WorkItem is outside this Objective Chat scope.");
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

  #workItemPatch(objectiveId, patch) {
    const objective = this.objectiveService.getObjective(objectiveId);
    if (patch.mainAgentId != null) {
      const agentId = text(patch.mainAgentId, "mainAgentId");
      const agent = this.store.getAgent(agentId);
      if (!agent) throw coded("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
      if (agent.role !== "independentContributor" || !objective.contributorAgentIds.includes(agentId)) {
        throw coded("AGENT_OUTSIDE_OBJECTIVE", "WorkItem Agent must be an Independent Contributor attached to this Objective.");
      }
    }
    if (patch.mainWorkspaceId != null) {
      const workspaceId = text(patch.mainWorkspaceId, "mainWorkspaceId");
      if (!objective.workspaceIds.includes(workspaceId) || !this.store.getGitRepository(workspaceId)) {
        throw coded("WORKSPACE_OUTSIDE_OBJECTIVE", "WorkItem Workspace must be attached to this Objective.");
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
function object(value, field) { if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("INVALID_INPUT", `${field} must be an object.`); return value; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
