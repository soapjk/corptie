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
export const workChatDynamicTools = Object.freeze([
  tool("corptie_work_context", "Read the current Work Chat scope. Mutating Task operations use the strict corptie_collaboration_tasks_* Session-scoped tools."),
  tool("corptie_work_agents_list", "List contributor Agents in this Work. Discover their actual receiving Sessions before routing collaboration.")
]);

export function callWorkChatDynamicTool(service, input = {}) {
  if (!service) throw coded("WORK_CHAT_UNAVAILABLE", "Work Chat operations are unavailable.");
  return service.execute(input);
}

export class WorkChatOperationService {
  constructor(options = {}) {
    this.store = options.store;
    this.workService = options.workService;
    this.contextService = options.contextService;
    this.workSessionStartApplicationService = options.workSessionStartApplicationService;
    this.defaultProviderId = options.defaultProviderId;
    if (!this.store || !this.workService || !this.contextService
      || typeof this.workSessionStartApplicationService?.start !== "function" || !this.defaultProviderId) {
      throw new TypeError("WorkChatOperationService requires store, workService, contextService, and WorkSessionStartApplicationService.");
    }
  }

  async execute(input = {}) {
    const workId = scopedWorkId(input.metadata);
    const args = input.arguments ?? {};
    switch (input.tool) {
      case "corptie_work_context": return this.contextService.build(workId);
      case "corptie_work_update": return this.workService.updateWork(
        workId,
        this.#workPatch(workId, object(args.patch, "patch"))
      );
      case "corptie_work_agents_list": return this.#agents(workId);
      case "corptie_work_tasks_manage": return this.#tasks(workId, args);
      case "corptie_work_task_start": {
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
      default: throw coded("HOST_TOOL_UNSUPPORTED", `Unsupported Work Chat tool: ${input.tool}`);
    }
  }

  #agents(workId) {
    const work = this.workService.getWork(workId);
    const contributors = new Set(work.contributorAgentIds);
    return this.store.listAgents().filter((agent) => contributors.has(agent.agentId)).map((agent) => ({
      agentId: agent.agentId, name: agent.name, role: agent.role,
      description: agent.description, status: agent.status,
      isContributor: true,
      canStartTask: agent.role === "independentContributor"
    }));
  }

  #tasks(workId, args) {
    switch (text(args.action, "action")) {
      case "list": return this.workService.listTasksByWork(workId);
      case "get": return this.#task(workId, text(args.task_id, "task_id"));
      case "create": return this.workService.createTask({
        ...this.#taskPatch(workId, object(args.patch ?? {}, "patch")), workId, title: text(args.title, "title")
      });
      case "update": {
        const item = this.#task(workId, text(args.task_id, "task_id"));
        return this.workService.updateTask(item.id, this.#taskPatch(workId, object(args.patch, "patch")));
      }
      case "delete": {
        const item = this.#task(workId, text(args.task_id, "task_id"));
        this.workService.deleteTask(item.id);
        return { deleted: true };
      }
      default: throw coded("INVALID_ACTION", `Unsupported Task action: ${args.action}`);
    }
  }

  #task(workId, taskId) {
    const item = this.workService.getTask(taskId);
    if (item.work_id !== workId) throw coded("TASK_OUTSIDE_WORK", "Task is outside this Work Chat scope.");
    return item;
  }

  #workPatch(workId, patch) {
    if (Array.isArray(patch.contributorAgentIds)) {
      for (const id of patch.contributorAgentIds) {
        const agent = this.store.getAgent(text(id, "contributorAgentIds[]"));
        if (!agent) throw coded("AGENT_NOT_FOUND", `Contributor Agent not found: ${id}`);
      }
    }
    return patch;
  }

  #taskPatch(workId, patch) {
    const work = this.workService.getWork(workId);
    if (patch.mainAgentId != null) {
      const agentId = text(patch.mainAgentId, "mainAgentId");
      const agent = this.store.getAgent(agentId);
      if (!agent) throw coded("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
      if (agent.role !== "independentContributor" || !work.contributorAgentIds.includes(agentId)) {
        throw coded("AGENT_OUTSIDE_WORK", "Task Agent must be an Independent Contributor attached to this Work.");
      }
    }
    return patch;
  }
}

function scopedWorkId(metadata) {
  if (metadata?.sessionKind !== "workChat") throw coded("WORK_CHAT_SCOPE_REQUIRED", "Work Chat scope is required.");
  return text(metadata.workId, "workId");
}
function text(value, field) { const result = typeof value === "string" ? value.trim() : ""; if (!result) throw coded("INVALID_INPUT", `${field} is required.`); return result; }
function optionalText(value) { const result = typeof value === "string" ? value.trim() : ""; return result || null; }
function positiveInteger(value, field) { const result = Number(value); if (!Number.isInteger(result) || result < 1) throw coded("TASK_VERSION_CONFLICT", `${field} must be a positive integer.`); return result; }
function object(value, field) { if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("INVALID_INPUT", `${field} must be an object.`); return value; }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
