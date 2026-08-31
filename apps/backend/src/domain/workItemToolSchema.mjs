export const WORK_ITEM_PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const WORK_ITEM_STATUSES = Object.freeze(["todo", "in_progress", "done"]);
export const COLLABORATION_RELATION_TYPES = Object.freeze([
  "depends_on", "blocks", "review_of"
]);
export const COLLABORATION_ROUTING_INTENTS = Object.freeze([
  "existing_work_item_session", "create_dedicated_session", "best_available"
]);

const id = (prefix, description) => ({
  type: "string",
  minLength: 1,
  description: `${description} Canonical new IDs use the ${prefix}: namespace; legacy stable IDs remain accepted during migration.`
});

export const repositoryIdSchema = id("repository", "Registered logical Workspace repository: ID; filesystem paths are not accepted.");
export const agentIdSchema = id("agent", "Stable Agent identity and authorization principal (agent: ID).");
export const workItemIdSchema = id("work_item", "Stable WorkItem identity (work_item: ID) within its owning Objective.");
export const sessionIdSchema = id("session", "Stable logical Session identity (session: ID), not a Provider thread id.");
export const objectiveIdSchema = id("objective", "Stable Objective identity (objective: ID).");

export const workItemFieldsSchema = Object.freeze({
  description: { type: "string", description: "Detailed WorkItem scope and constraints." },
  acceptance_criteria: {
    type: "string",
    description: "Human-readable acceptance criteria. Completion still requires the dedicated acceptance workflow."
  },
  priority: { type: "string", enum: [...WORK_ITEM_PRIORITIES] },
  status: { type: "string", enum: [...WORK_ITEM_STATUSES] },
  main_workspace_id: { ...repositoryIdSchema, type: ["string", "null"] },
  main_agent_id: { ...agentIdSchema, type: ["string", "null"] }
});

export const workItemPatchSchema = Object.freeze({
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: workItemFieldsSchema.description,
    acceptanceCriteria: workItemFieldsSchema.acceptance_criteria,
    priority: { type: "string", enum: [...WORK_ITEM_PRIORITIES] },
    status: { type: "string", enum: [...WORK_ITEM_STATUSES] },
    mainWorkspaceId: { type: ["string", "null"], description: repositoryIdSchema.description },
    mainAgentId: { type: ["string", "null"], description: agentIdSchema.description }
  },
  additionalProperties: false
});

export function toolDefinition(name, description, properties = {}, required = []) {
  return Object.freeze({
    type: "function",
    name,
    description,
    deferLoading: false,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
}
