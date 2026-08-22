export const scheduledSessionTaskDynamicTools = Object.freeze([
  Object.freeze({
    type: "function",
    name: "corptie_scheduled_tasks_manage",
    description: "Manage Corptie 计划任务 for a logical Session. Create one-time, fixed-interval, or condition tasks; inspect/list/update/pause/resume/cancel them; or run one immediately. For a condition task, Corptie runs the supplied script at check_interval_seconds: exit 0 means the condition is satisfied and wakes the Session once, while any non-zero exit means not yet satisfied and polling continues. Actor identity is injected by the Tool Host and cannot be supplied here.",
    deferLoading: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "get", "list", "update", "pause", "resume", "cancel", "run"], description: "Operation to perform on a 计划任务." },
        task_id: { type: "string", minLength: 1, description: "Required except for create and list." },
        logical_session_id: { type: "string", minLength: 1, description: "Target logical Session. Required for create; optional list filter. Never pass a Provider thread id." },
        message: {
          oneOf: [
            { type: "string", minLength: 1 },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string", minLength: 1 },
                type: { type: "string", minLength: 1 },
                payload: { type: "object", additionalProperties: true }
              },
              required: ["text"]
            }
          ]
        },
        schedule_type: { type: "string", enum: ["once", "interval", "condition"], description: "Required for create. once uses run_at; interval uses interval_seconds; condition uses condition." },
        run_at: { type: "string", description: "ISO-8601 first execution time. Required for once; optional for interval and condition." },
        interval_seconds: { type: "integer", minimum: 1, description: "Fixed interval in seconds for interval tasks." },
        timezone: { type: "string" },
        missed_policy: { type: "string", enum: ["coalesce_once", "skip"] },
        condition: {
          type: "object",
          additionalProperties: false,
          properties: {
            script: { type: "string", minLength: 1, description: "Shell condition script. Exit 0 means satisfied; non-zero means keep polling." },
            check_interval_seconds: { type: "integer", minimum: 1, maximum: 86400, description: "Seconds between checks; defaults to 5." },
            timeout_seconds: { type: "integer", minimum: 1, maximum: 300, description: "Maximum duration of each check; defaults to 30." },
            working_directory: { type: "string", minLength: 1, description: "Optional absolute working directory." }
          },
          required: ["script"]
        },
        max_retries: { type: "integer", minimum: 0, maximum: 20 },
        resource_version: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ["active", "paused", "completed", "failed", "cancelled"] }
      },
      required: ["action"]
    }
  })
]);

export async function callScheduledSessionTaskDynamicTool(service, input = {}) {
  const args = input.arguments ?? {};
  const actor = { type: "agent", id: input.actorId };
  switch (args.action) {
    case "create": return service.create(toTaskInput(args), actor);
    case "get": return service.get(required(args.task_id, "task_id"), actor);
    case "list": return { tasks: service.list({ logicalSessionId: args.logical_session_id, status: args.status }, actor) };
    case "update": return service.update(required(args.task_id, "task_id"), toTaskPatch(args), actor);
    case "pause": return service.pause(required(args.task_id, "task_id"), actor);
    case "resume": return service.resume(required(args.task_id, "task_id"), actor);
    case "cancel": return service.cancel(required(args.task_id, "task_id"), actor);
    case "run": return service.runNow(required(args.task_id, "task_id"), actor);
    default: {
      const error = new Error(`Unsupported 计划任务 action: ${args.action}`);
      error.code = "INVALID_ACTION";
      throw error;
    }
  }
}

function toTaskInput(args) {
  return {
    logicalSessionId: args.logical_session_id,
    message: args.message,
    scheduleType: args.schedule_type,
    runAt: args.run_at,
    intervalSeconds: args.interval_seconds,
    timezone: args.timezone,
    missedPolicy: args.missed_policy,
    condition: toCondition(args.condition),
    maxRetries: args.max_retries
  };
}

function toTaskPatch(args) {
  const mappings = {
    message: "message",
    run_at: "runAt",
    interval_seconds: "intervalSeconds",
    timezone: "timezone",
    missed_policy: "missedPolicy",
    condition: "condition",
    max_retries: "maxRetries",
    resource_version: "resourceVersion"
  };
  const patch = Object.fromEntries(Object.entries(mappings)
    .filter(([source]) => Object.hasOwn(args, source))
    .map(([source, target]) => [target, args[source]]));
  if (Object.hasOwn(patch, "condition")) patch.condition = toCondition(patch.condition);
  return patch;
}

function toCondition(condition) {
  if (condition == null) return undefined;
  return {
    script: condition.script,
    checkIntervalSeconds: condition.check_interval_seconds,
    timeoutSeconds: condition.timeout_seconds,
    workingDirectory: condition.working_directory
  };
}

function required(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  const error = new TypeError(`${field} is required.`);
  error.code = "INVALID_INPUT";
  throw error;
}
