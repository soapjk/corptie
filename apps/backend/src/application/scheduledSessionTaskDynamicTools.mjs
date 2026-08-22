export const scheduledSessionTaskDynamicTools = Object.freeze([
  Object.freeze({
    type: "function",
    name: "corptie_scheduled_session_tasks_manage",
    description: "Create, inspect, list, update, pause, resume, cancel, or immediately run persistent logical Session schedules.",
    deferLoading: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "get", "list", "update", "pause", "resume", "cancel", "run"] },
        task_id: { type: "string", minLength: 1 },
        logical_session_id: { type: "string", minLength: 1 },
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
        schedule_type: { type: "string", enum: ["once", "interval", "process"] },
        run_at: { type: "string" },
        interval_seconds: { type: "integer", minimum: 1 },
        timezone: { type: "string" },
        missed_policy: { type: "string", enum: ["coalesce_once", "skip"] },
        process: {
          type: "object",
          additionalProperties: false,
          properties: {
            pid: { type: "integer", minimum: 1 },
            pollIntervalSeconds: { type: "integer", minimum: 1 },
            expectedStartTime: { type: "string" }
          },
          required: ["pid"]
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
      const error = new Error(`Unsupported scheduled Session task action: ${args.action}`);
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
    process: args.process,
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
    process: "process",
    max_retries: "maxRetries",
    resource_version: "resourceVersion"
  };
  return Object.fromEntries(Object.entries(mappings)
    .filter(([source]) => Object.hasOwn(args, source))
    .map(([source, target]) => [target, args[source]]));
}

function required(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  const error = new TypeError(`${field} is required.`);
  error.code = "INVALID_INPUT";
  throw error;
}
