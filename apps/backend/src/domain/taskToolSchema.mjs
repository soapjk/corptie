export const TASK_PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const TASK_LIFECYCLE_STATES = Object.freeze(["todo", "in_progress", "done"]);
export const COLLABORATION_RELATION_TYPES = Object.freeze([
  "depends_on", "blocks", "review_of"
]);
export const COLLABORATION_ROUTING_INTENTS = Object.freeze([
  "existing_task_session", "create_dedicated_session", "best_available"
]);

const id = (prefix, description) => ({
  type: "string",
  minLength: 1,
  description: `${description} Canonical IDs use the ${prefix}: namespace.`
});

export const repositoryIdSchema = id("repository", "Registered logical Workspace repository: ID; filesystem paths are not accepted.");
export const roleIdSchema = id("agent", "Stable Role configuration resource ID, not an executor or authorization principal. The historical agent: namespace is retained.");
// Compatibility export for existing tool parameter names and Provider bindings.
export const agentIdSchema = roleIdSchema;
export const taskIdSchema = id("task", "Stable Task identity (task: ID) within its owning Work.");
export const sessionIdSchema = id("session", "Stable logical Session identity (session: ID), not a Provider thread id.");
export const workIdSchema = id("work", "Stable Work identity (work: ID).");

export const taskFieldsSchema = Object.freeze({
  priority: { type: "string", enum: [...TASK_PRIORITIES] },
  lifecycle_state: { type: "string", enum: [...TASK_LIFECYCLE_STATES] },
  main_agent_id: { ...agentIdSchema, type: ["string", "null"] }
});

export const taskPatchSchema = Object.freeze({
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    priority: { type: "string", enum: [...TASK_PRIORITIES] },
    lifecycleState: { type: "string", enum: [...TASK_LIFECYCLE_STATES] },
    mainAgentId: { type: ["string", "null"], description: agentIdSchema.description },
    parentTaskId: { type: ["string", "null"], description: "Creation only: root Task in the same Work. Reparenting is not supported." }
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
