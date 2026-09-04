const triggerConditionalRules = Object.freeze([
  Object.freeze({
    if: { properties: { schedule_type: { enum: ["at", "once"] } }, required: ["schedule_type"] },
    then: { required: ["run_at"] }
  }),
  Object.freeze({
    if: { properties: { schedule_type: { const: "after" } }, required: ["schedule_type"] },
    then: { required: ["delay_seconds"] }
  }),
  Object.freeze({
    if: { properties: { schedule_type: { const: "interval" } }, required: ["schedule_type"] },
    then: { required: ["interval_seconds"] }
  }),
  Object.freeze({
    if: { properties: { schedule_type: { const: "condition" } }, required: ["schedule_type"] },
    then: { required: ["condition"] }
  }),
  Object.freeze({
    if: { properties: { schedule_type: { const: "processExit" } }, required: ["schedule_type"] },
    then: { required: ["process"] }
  })
]);

const scheduledSessionTaskManageTool = Object.freeze({
    type: "function",
    name: "corptie_scheduled_tasks_manage",
    description: "Manage provider-neutral Corptie Automations（计划任务）for a Logical Session. Create requires a concise name plus exactly one of expires_at or expires_after_seconds. Supports at, after, interval, processExit, and structured condition triggers plus local Session message, activation, and notification actions. Actor identity is injected by the Tool Host and permissions are rechecked before every run.",
    deferLoading: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "get", "list", "update", "pause", "resume", "cancel", "run"], description: "Operation to perform on a 计划任务." },
        task_id: { type: "string", minLength: 1, description: "Required except for create and list." },
        logical_session_id: { type: "string", minLength: 1, description: "Optional target logical Session. Create defaults to the calling Agent's current logical Session. Never pass a Provider thread id." },
        name: { type: "string", minLength: 1, maxLength: 120 },
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
        schedule_type: { type: "string", enum: ["at", "after", "interval", "processExit", "condition", "once"], description: "Required for create. once is a compatibility alias for at." },
        run_at: { type: "string", description: "ISO-8601 first execution time. Required for once; optional for interval and condition." },
        delay_seconds: { type: "integer", minimum: 1, maximum: 31536000 },
        interval_seconds: { type: "integer", minimum: 1, description: "Fixed interval in seconds for interval tasks." },
        timezone: { type: "string" },
        expires_at: { type: "string", description: "ISO-8601 expiration timestamp. For create, specify exactly one of expires_at or expires_after_seconds." },
        expires_after_seconds: { type: "integer", minimum: 1, maximum: 315360000, description: "Countdown from creation to expiration in seconds. For create, specify exactly one expiration field." },
        missed_policy: { type: "string", enum: ["skip", "fireOnce", "catchUp", "coalesce_once"] },
        actions: {
          type: "array", minItems: 1, maxItems: 16,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["queueSessionMessage", "activateSession", "localNotification"] },
              message: { oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }] },
              title: { type: "string" },
              body: { type: "string" }
            },
            required: ["type"]
          }
        },
        process: {
          type: "object", additionalProperties: false,
          properties: {
            pid: { type: "integer", minimum: 1 },
            poll_interval_seconds: { type: "integer", minimum: 1, maximum: 3600 },
            expected_start_time: { type: "string" }
          },
          required: ["pid"]
        },
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
        max_concurrent_runs: { type: "integer", minimum: 1, maximum: 32 },
        max_catch_up_runs: { type: "integer", minimum: 1, maximum: 100 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
        backpressure_limit: { type: "integer", minimum: 1, maximum: 10000 },
        resource_version: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ["active", "cancelled", "completed", "expired", "error"] }
      },
      required: ["action"],
      allOf: [{
        if: { properties: { action: { const: "create" } }, required: ["action"] },
        then: {
          required: ["name", "schedule_type"],
          oneOf: [
            { required: ["expires_at"], not: { required: ["expires_after_seconds"] } },
            { required: ["expires_after_seconds"], not: { required: ["expires_at"] } }
          ],
          allOf: triggerConditionalRules
        }
      }, ...triggerConditionalRules]
    }
  });

const manageProperties = scheduledSessionTaskManageTool.inputSchema.properties;
const automationIdProperty = { type: "string", minLength: 1 };
const automationToolActions = Object.freeze({
  corptie_automations_create: "create",
  corptie_automations_list: "list",
  corptie_automations_get: "get",
  corptie_automations_update: "update",
  corptie_automations_pause: "pause",
  corptie_automations_resume: "resume",
  corptie_automations_cancel: "cancel",
  corptie_automations_run_now: "run"
});
const automationActionTools = [
  ["corptie_automations_get", "get", "Get one authorized Automation with Run stages, action results, routing data, and audit history."],
  ["corptie_automations_pause", "pause", "Pause an authorized Automation."],
  ["corptie_automations_resume", "resume", "Resume an authorized Automation that is in an error state."],
  ["corptie_automations_cancel", "cancel", "Cancel an authorized Automation while preserving its audit history."],
  ["corptie_automations_run_now", "run", "Run an authorized Automation immediately."]
].map(([name, action, description]) => Object.freeze({
  type: "function",
  name,
  description,
  deferLoading: false,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { automation_id: automationIdProperty },
    required: ["automation_id"]
  }
}));

export const scheduledSessionTaskDynamicTools = Object.freeze([
  scheduledSessionTaskManageTool,
  Object.freeze({
    type: "function",
    name: "corptie_automations_create",
    description: "Create a provider-neutral Corptie Automation for this authenticated logical Session by default. Requires a concise name and exactly one expiration field.",
    deferLoading: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(Object.entries(manageProperties).filter(([name]) => ![
        "action", "task_id", "status"
      ].includes(name))),
      required: ["name", "schedule_type"],
      allOf: [{
        oneOf: [
          { required: ["expires_at"], not: { required: ["expires_after_seconds"] } },
          { required: ["expires_after_seconds"], not: { required: ["expires_at"] } }
        ]
      }]
    }
  }),
  Object.freeze({
    type: "function",
    name: "corptie_automations_list",
    description: "List Automations for this authenticated logical Session by default, optionally filtering by status.",
    deferLoading: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        logical_session_id: manageProperties.logical_session_id,
        status: manageProperties.status
      }
    }
  }),
  Object.freeze({
    type: "function",
    name: "corptie_automations_update",
    description: "Update mutable fields of an authorized Automation using its current resource_version.",
    deferLoading: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        automation_id: automationIdProperty,
        ...Object.fromEntries(Object.entries(manageProperties).filter(([name]) => ![
          "action", "task_id", "logical_session_id", "schedule_type", "delay_seconds", "status"
        ].includes(name)))
      },
      required: ["automation_id", "resource_version"]
    }
  }),
  ...automationActionTools
]);

export async function callScheduledSessionTaskDynamicTool(service, input = {}) {
  const rawArgs = input.arguments ?? {};
  const args = {
    ...rawArgs,
    action: automationToolActions[input.tool] ?? rawArgs.action,
    task_id: rawArgs.task_id ?? rawArgs.automation_id,
    logical_session_id: rawArgs.logical_session_id ?? input.metadata?.logicalSessionId
  };
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
  required(args.name, "name");
  requireExpiration(args);
  return {
    name: args.name,
    logicalSessionId: args.logical_session_id,
    message: args.message,
    scheduleType: args.schedule_type,
    runAt: args.run_at,
    delaySeconds: args.delay_seconds,
    intervalSeconds: args.interval_seconds,
    timezone: args.timezone,
    expiresAt: args.expires_at,
    expiresAfterSeconds: args.expires_after_seconds,
    missedPolicy: args.misfire_policy ?? args.missed_policy,
    actions: args.actions,
    process: toProcess(args.process),
    condition: toCondition(args.condition),
    maxRetries: args.max_retries,
    maxConcurrentRuns: args.max_concurrent_runs,
    maxCatchUpRuns: args.max_catch_up_runs,
    timeoutSeconds: args.timeout_seconds,
    backpressureLimit: args.backpressure_limit
  };
}

function toProcess(process) {
  if (process == null) return undefined;
  return {
    pid: process.pid,
    pollIntervalSeconds: process.poll_interval_seconds,
    expectedStartTime: process.expected_start_time
  };
}

function toTaskPatch(args) {
  const mappings = {
    message: "message",
    name: "name",
    actions: "actions",
    process: "process",
    run_at: "runAt",
    interval_seconds: "intervalSeconds",
    timezone: "timezone",
    expires_at: "expiresAt",
    expires_after_seconds: "expiresAfterSeconds",
    missed_policy: "missedPolicy",
    misfire_policy: "missedPolicy",
    condition: "condition",
    max_retries: "maxRetries",
    max_concurrent_runs: "maxConcurrentRuns",
    max_catch_up_runs: "maxCatchUpRuns",
    timeout_seconds: "timeoutSeconds",
    backpressure_limit: "backpressureLimit",
    resource_version: "resourceVersion"
  };
  const patch = Object.fromEntries(Object.entries(mappings)
    .filter(([source]) => Object.hasOwn(args, source))
    .map(([source, target]) => [target, args[source]]));
  if (Object.hasOwn(patch, "condition")) patch.condition = toCondition(patch.condition);
  if (Object.hasOwn(patch, "process")) patch.process = toProcess(patch.process);
  return patch;
}

function requireExpiration(args) {
  const count = Number(args.expires_at != null) + Number(args.expires_after_seconds != null);
  if (count === 1) return;
  const error = new TypeError("Create requires exactly one of expires_at or expires_after_seconds.");
  error.code = "INVALID_INPUT";
  error.field = "expires_at";
  throw error;
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
