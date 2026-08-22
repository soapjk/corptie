const SCHEDULE_TYPES = new Set(["once", "interval", "condition", "process"]);
const MISSED_POLICIES = new Set(["coalesce_once", "skip"]);

export function validateScheduledSessionTaskInput(input = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const logicalSessionId = requiredText(input.logicalSessionId, "logicalSessionId");
  const scheduleType = requiredText(input.scheduleType, "scheduleType");
  if (!SCHEDULE_TYPES.has(scheduleType)) invalid("scheduleType", "must be once, interval, or condition");
  const message = normalizeMessage(input.message);
  const timezone = normalizeTimezone(input.timezone ?? "UTC");
  const missedPolicy = input.missedPolicy ?? "coalesce_once";
  if (!MISSED_POLICIES.has(missedPolicy)) invalid("missedPolicy", "must be coalesce_once or skip");
  const maxRetries = integer(input.maxRetries ?? 5, "maxRetries", 0, 20);

  let runAt = null;
  let nextRunAt = null;
  let intervalSeconds = null;
  let conditionSpec = null;
  let processSpec = null;
  if (scheduleType === "once") {
    runAt = timestamp(input.runAt, "runAt");
    nextRunAt = runAt;
  } else if (scheduleType === "interval") {
    intervalSeconds = integer(input.intervalSeconds, "intervalSeconds", 1, 31_536_000);
    runAt = input.runAt == null
      ? new Date(now.getTime() + intervalSeconds * 1000).toISOString()
      : timestamp(input.runAt, "runAt");
    nextRunAt = runAt;
  } else if (scheduleType === "condition") {
    conditionSpec = normalizeConditionSpec(input.condition);
    nextRunAt = input.runAt == null ? now.toISOString() : timestamp(input.runAt, "runAt");
    runAt = nextRunAt;
  } else {
    processSpec = normalizeProcessSpec(input.process);
    nextRunAt = input.runAt == null ? now.toISOString() : timestamp(input.runAt, "runAt");
    runAt = nextRunAt;
  }

  return Object.freeze({
    logicalSessionId,
    message,
    scheduleType,
    runAt,
    nextRunAt,
    intervalSeconds,
    timezone,
    missedPolicy,
    conditionSpec,
    conditionState: scheduleType === "condition" ? emptyMonitorState() : null,
    processSpec,
    processState: scheduleType === "process" ? emptyMonitorState() : null,
    maxRetries
  });
}

export function validateScheduledSessionTaskPatch(input = {}, task, options = {}) {
  const mutable = ["message", "runAt", "intervalSeconds", "timezone", "missedPolicy", "condition", "process", "maxRetries"];
  const unknown = Object.keys(input).filter((key) => !mutable.includes(key) && key !== "resourceVersion");
  if (unknown.length > 0) invalid(unknown[0], "is not mutable");
  const candidate = {
    logicalSessionId: task.logicalSessionId,
    scheduleType: task.scheduleType,
    message: Object.hasOwn(input, "message") ? input.message : task.message,
    runAt: Object.hasOwn(input, "runAt") ? input.runAt : task.runAt,
    intervalSeconds: Object.hasOwn(input, "intervalSeconds") ? input.intervalSeconds : task.intervalSeconds,
    timezone: Object.hasOwn(input, "timezone") ? input.timezone : task.timezone,
    missedPolicy: Object.hasOwn(input, "missedPolicy") ? input.missedPolicy : task.missedPolicy,
    condition: Object.hasOwn(input, "condition") ? input.condition : task.conditionSpec,
    process: Object.hasOwn(input, "process") ? input.process : task.processSpec,
    maxRetries: Object.hasOwn(input, "maxRetries") ? input.maxRetries : task.maxRetries
  };
  return validateScheduledSessionTaskInput(candidate, options);
}

function emptyMonitorState() {
  return {
    firstObservedAt: null,
    lastObservedAt: null,
    lastObservation: null,
    terminalObservedAt: null
  };
}

function normalizeConditionSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("condition", "is required for condition schedules");
  }
  const allowed = new Set(["script", "checkIntervalSeconds", "timeoutSeconds", "workingDirectory"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`condition.${unknown[0]}`, "is not supported");
  const script = requiredText(value.script, "condition.script");
  if (script.length > 100_000) invalid("condition.script", "must not exceed 100000 characters");
  const workingDirectory = value.workingDirectory == null
    ? null
    : requiredText(value.workingDirectory, "condition.workingDirectory");
  if (workingDirectory != null && !workingDirectory.startsWith("/")) {
    invalid("condition.workingDirectory", "must be an absolute path");
  }
  return {
    script,
    checkIntervalSeconds: integer(value.checkIntervalSeconds ?? 5, "condition.checkIntervalSeconds", 1, 86_400),
    timeoutSeconds: integer(value.timeoutSeconds ?? 30, "condition.timeoutSeconds", 1, 300),
    workingDirectory
  };
}

export function nextIntervalRun(scheduledFor, intervalSeconds, now = new Date()) {
  const origin = new Date(scheduledFor).getTime();
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const intervalMs = intervalSeconds * 1000;
  const steps = Math.max(1, Math.floor((current - origin) / intervalMs) + 1);
  return new Date(origin + steps * intervalMs).toISOString();
}

function normalizeMessage(value) {
  if (typeof value === "string") value = { text: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("message", "must be a string or object");
  const allowed = new Set(["text", "type", "payload"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`message.${unknown[0]}`, "is not supported");
  const text = requiredText(value.text, "message.text");
  if (text.length > 100_000) invalid("message.text", "must not exceed 100000 characters");
  const type = value.type == null ? "scheduled_session_message" : requiredText(value.type, "message.type");
  if (value.payload != null && (typeof value.payload !== "object" || Array.isArray(value.payload))) {
    invalid("message.payload", "must be an object");
  }
  return { text, type, payload: value.payload ?? {} };
}

function normalizeProcessSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("process", "is required for process schedules");
  const allowed = new Set(["pid", "pollIntervalSeconds", "expectedStartTime"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`process.${unknown[0]}`, "is not supported");
  return {
    pid: integer(value.pid, "process.pid", 1, 2_147_483_647),
    pollIntervalSeconds: integer(value.pollIntervalSeconds ?? 2, "process.pollIntervalSeconds", 1, 3600),
    expectedStartTime: value.expectedStartTime == null ? null : timestamp(value.expectedStartTime, "process.expectedStartTime")
  };
}

function normalizeTimezone(value) {
  const timezone = requiredText(value, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    invalid("timezone", "is not a valid IANA time zone");
  }
  return timezone;
}

function timestamp(value, field) {
  const text = requiredText(value, field);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) invalid(field, "must be an ISO-8601 timestamp");
  return date.toISOString();
}

function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) invalid(field, `must be an integer from ${min} to ${max}`);
  return number;
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) invalid(field, "is required");
  return text;
}

function invalid(field, reason) {
  const error = new TypeError(`${field} ${reason}.`);
  error.code = "INVALID_SCHEDULED_SESSION_TASK";
  error.field = field;
  throw error;
}
