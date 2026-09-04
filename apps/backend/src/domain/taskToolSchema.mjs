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
export const agentIdSchema = id("agent", "Stable Agent identity and authorization principal (agent: ID).");
export const taskIdSchema = id("task", "Stable Task identity (task: ID) within its owning Work.");
export const sessionIdSchema = id("session", "Stable logical Session identity (session: ID), not a Provider thread id.");
export const workIdSchema = id("work", "Stable Work identity (work: ID).");

export const taskFieldsSchema = Object.freeze({
  description: { type: "string", description: "Detailed Task scope and constraints." },
  acceptance_criteria: {
    type: "string",
    description: "Human-readable acceptance criteria. Completion still requires the dedicated acceptance workflow."
  },
  verification_criteria: { type: "string", description: "Evidence required to verify the current Task revision." },
  priority: { type: "string", enum: [...TASK_PRIORITIES] },
  lifecycle_state: { type: "string", enum: [...TASK_LIFECYCLE_STATES] },
  main_agent_id: { ...agentIdSchema, type: ["string", "null"] }
});

export const taskPatchSchema = Object.freeze({
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: taskFieldsSchema.description,
    acceptanceCriteria: taskFieldsSchema.acceptance_criteria,
    verificationCriteria: taskFieldsSchema.verification_criteria,
    priority: { type: "string", enum: [...TASK_PRIORITIES] },
    lifecycleState: { type: "string", enum: [...TASK_LIFECYCLE_STATES] },
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
