const SCHEDULE_TYPES = new Set(["once", "at", "after", "interval", "condition", "process", "processExit"]);
const MISFIRE_POLICIES = new Set(["skip", "fireOnce", "catchUp", "coalesce_once"]);
const ACTION_TYPES = new Set(["queueSessionMessage", "activateSession", "localNotification"]);

export function validateScheduledSessionTaskInput(input = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  rejectUnknown(input, new Set([
    "taskId", "automationId", "name", "logicalSessionId", "message", "scheduleType", "trigger",
    "runAt", "delaySeconds", "intervalSeconds", "timezone", "missedPolicy", "misfirePolicy",
    "expiresAt", "expiresAfterSeconds",
    "condition", "conditions", "process", "actions", "maxRetries", "maxConcurrentRuns",
    "maxCatchUpRuns", "timeoutSeconds", "backpressureLimit", "risk"
  ]));
  const logicalSessionId = requiredText(input.logicalSessionId, "logicalSessionId");
  const requestedType = requiredText(input.trigger?.type ?? input.scheduleType, "scheduleType");
  if (!SCHEDULE_TYPES.has(requestedType)) invalid("scheduleType", "must be at, after, interval, processExit, or condition");
  const triggerType = canonicalTriggerType(requestedType);
  const scheduleType = legacyScheduleType(triggerType);
  const triggerInput = input.trigger && typeof input.trigger === "object" ? input.trigger : {};
  validateTriggerShape(triggerType, triggerInput);
  const actions = normalizeActions(input.actions, input.message);
  const messageAction = actions.find((action) => action.type === "queueSessionMessage");
  const message = messageAction?.message ?? normalizeMessage(input.message ?? { text: "Automation triggered" });
  const timezone = normalizeTimezone(input.timezone ?? systemTimezone());
  const expiresAt = normalizeExpiration(input, now);
  const misfirePolicy = input.misfirePolicy ?? input.missedPolicy ?? "fireOnce";
  if (!MISFIRE_POLICIES.has(misfirePolicy)) invalid("misfirePolicy", "must be skip, fireOnce, or catchUp");
  const canonicalMisfirePolicy = misfirePolicy === "coalesce_once" ? "fireOnce" : misfirePolicy;
  // Keep the legacy constrained column compatible; policySpec is authoritative.
  const missedPolicy = canonicalMisfirePolicy === "skip" ? "skip" : "coalesce_once";
  const maxRetries = integer(input.maxRetries ?? 5, "maxRetries", 0, 20);
  const maxConcurrentRuns = integer(input.maxConcurrentRuns ?? 1, "maxConcurrentRuns", 1, 32);
  const maxCatchUpRuns = integer(input.maxCatchUpRuns ?? 10, "maxCatchUpRuns", 1, 100);
  const timeoutSeconds = integer(input.timeoutSeconds ?? 3600, "timeoutSeconds", 1, 86_400);
  const backpressureLimit = integer(input.backpressureLimit ?? 100, "backpressureLimit", 1, 10_000);
  const name = requiredText(input.name, "name");
  if (name.length > 120) invalid("name", "must contain at most 120 characters");

  let runAt = null;
  let nextRunAt = null;
  let intervalSeconds = null;
  let delaySeconds = null;
  let conditionSpec = null;
  let processSpec = null;
  if (triggerType === "at") {
    runAt = timestamp(triggerInput.at ?? input.runAt, "runAt");
    nextRunAt = runAt;
  } else if (triggerType === "after") {
    delaySeconds = integer(triggerInput.delaySeconds ?? input.delaySeconds, "delaySeconds", 1, 31_536_000);
    runAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    nextRunAt = runAt;
  } else if (triggerType === "interval") {
    intervalSeconds = integer(triggerInput.intervalSeconds ?? input.intervalSeconds, "intervalSeconds", 1, 31_536_000);
    runAt = (triggerInput.startAt ?? input.runAt) == null
      ? new Date(now.getTime() + intervalSeconds * 1000).toISOString()
      : timestamp(triggerInput.startAt ?? input.runAt, "runAt");
    nextRunAt = runAt;
  } else if (triggerType === "condition") {
    conditionSpec = normalizeConditionSpec(triggerInput.condition ?? input.condition ?? input.conditions?.[0]);
    nextRunAt = input.runAt == null ? now.toISOString() : timestamp(input.runAt, "runAt");
    runAt = nextRunAt;
  } else {
    processSpec = normalizeProcessSpec(triggerInput.process ?? input.process);
    nextRunAt = input.runAt == null ? now.toISOString() : timestamp(input.runAt, "runAt");
    runAt = nextRunAt;
  }
  if (nextRunAt != null && new Date(nextRunAt).getTime() >= new Date(expiresAt).getTime()) {
    invalid("expiresAt", "must be later than the first execution time");
  }

  return Object.freeze({
    logicalSessionId,
    name,
    message,
    scheduleType,
    triggerSpec: triggerSpec(triggerType, { runAt, delaySeconds, intervalSeconds, conditionSpec, processSpec, input: triggerInput }),
    conditionSpecs: conditionSpec ? [conditionSpec] : [],
    actions,
    policySpec: {
      misfire: canonicalMisfirePolicy,
      maxCatchUpRuns,
      maxConcurrentRuns,
      timeoutSeconds,
      backpressureLimit
    },
    risk: normalizeRisk(input.risk, actions, conditionSpec),
    runAt,
    nextRunAt,
    expiresAt,
    intervalSeconds,
    timezone,
    missedPolicy,
    conditionSpec,
    conditionState: scheduleType === "condition" ? emptyMonitorState() : null,
    processSpec,
    processState: scheduleType === "process" ? emptyMonitorState() : null,
    maxRetries,
    maxConcurrentRuns,
    timeoutSeconds,
    backpressureLimit
  });
}

export function validateScheduledSessionTaskPatch(input = {}, task, options = {}) {
  const mutable = ["name", "message", "runAt", "delaySeconds", "intervalSeconds", "timezone", "missedPolicy",
    "expiresAt", "expiresAfterSeconds",
    "misfirePolicy", "condition", "conditions", "process", "actions", "maxRetries", "maxConcurrentRuns",
    "maxCatchUpRuns", "timeoutSeconds", "backpressureLimit", "risk"];
  const unknown = Object.keys(input).filter((key) => !mutable.includes(key) && key !== "resourceVersion");
  if (unknown.length > 0) invalid(unknown[0], "is not mutable");
  const candidate = {
    logicalSessionId: task.logicalSessionId,
    scheduleType: task.scheduleType,
    name: Object.hasOwn(input, "name") ? input.name : task.name,
    message: Object.hasOwn(input, "message") ? input.message : task.message,
    runAt: Object.hasOwn(input, "runAt") ? input.runAt : task.runAt,
    expiresAt: Object.hasOwn(input, "expiresAfterSeconds")
      ? undefined
      : (Object.hasOwn(input, "expiresAt") ? input.expiresAt : task.expiresAt),
    expiresAfterSeconds: Object.hasOwn(input, "expiresAfterSeconds") ? input.expiresAfterSeconds : undefined,
    intervalSeconds: Object.hasOwn(input, "intervalSeconds") ? input.intervalSeconds : task.intervalSeconds,
    timezone: Object.hasOwn(input, "timezone") ? input.timezone : task.timezone,
    missedPolicy: Object.hasOwn(input, "missedPolicy") ? input.missedPolicy : task.missedPolicy,
    misfirePolicy: Object.hasOwn(input, "misfirePolicy") ? input.misfirePolicy : task.policySpec?.misfire,
    condition: Object.hasOwn(input, "condition") ? input.condition : task.conditionSpec,
    process: Object.hasOwn(input, "process") ? input.process : task.processSpec,
    actions: Object.hasOwn(input, "actions") ? input.actions : task.actions,
    maxRetries: Object.hasOwn(input, "maxRetries") ? input.maxRetries : task.maxRetries,
    maxConcurrentRuns: Object.hasOwn(input, "maxConcurrentRuns") ? input.maxConcurrentRuns : task.policySpec?.maxConcurrentRuns,
    maxCatchUpRuns: Object.hasOwn(input, "maxCatchUpRuns") ? input.maxCatchUpRuns : task.policySpec?.maxCatchUpRuns,
    timeoutSeconds: Object.hasOwn(input, "timeoutSeconds") ? input.timeoutSeconds : task.policySpec?.timeoutSeconds,
    backpressureLimit: Object.hasOwn(input, "backpressureLimit") ? input.backpressureLimit : task.policySpec?.backpressureLimit,
    risk: Object.hasOwn(input, "risk") ? input.risk : task.risk
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
  const allowed = new Set(["script", "checkIntervalSeconds", "timeoutSeconds", "workingDirectory", "protocol"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`condition.${unknown[0]}`, "is not supported");
  const script = requiredText(value.script, "condition.script");
  if (script.length > 100_000) invalid("condition.script", "must not exceed 100000 characters");
  rejectUnsafeObserverScript(script);
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
    workingDirectory,
    protocol: value.protocol ?? "structured-json-v1"
  };
}

function normalizeActions(value, legacyMessage) {
  const candidates = value == null
    ? [{ type: "queueSessionMessage", message: legacyMessage }]
    : value;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 16) {
    invalid("actions", "must contain from 1 to 16 actions");
  }
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) invalid(`actions.${index}`, "must be an object");
    const type = requiredText(candidate.type, `actions.${index}.type`);
    if (!ACTION_TYPES.has(type)) invalid(`actions.${index}.type`, "is not supported");
    if (type === "queueSessionMessage") {
      rejectUnknown(candidate, new Set(["type", "message"]), `actions.${index}`);
      return { type, message: normalizeMessage(candidate.message ?? legacyMessage) };
    }
    if (type === "activateSession") {
      rejectUnknown(candidate, new Set(["type"]), `actions.${index}`);
      return { type };
    }
    rejectUnknown(candidate, new Set(["type", "title", "body"]), `actions.${index}`);
    return {
      type,
      title: optionalText(candidate.title) ?? "Corptie Automation",
      body: requiredText(candidate.body ?? legacyMessage?.text ?? legacyMessage, `actions.${index}.body`)
    };
  });
}

function normalizeRisk(value, actions, conditionSpec) {
  if (value != null && (typeof value !== "object" || Array.isArray(value))) invalid("risk", "must be an object");
  if (value) rejectUnknown(value, new Set(["level", "summary", "remoteWrite", "destructive"]), "risk");
  if (value?.remoteWrite === true || value?.destructive === true) {
    invalid("risk", "cannot authorize remote-write or destructive Automation actions");
  }
  const level = value?.level ?? (conditionSpec ? "low" : "minimal");
  if (!["minimal", "low", "medium", "high"].includes(level)) invalid("risk.level", "is invalid");
  return {
    level,
    summary: optionalText(value?.summary) ?? (conditionSpec
      ? "Read-only condition observer; no network or filesystem writes."
      : `${actions.length} local action${actions.length === 1 ? "" : "s"}; remote writes are disabled.`),
    remoteWrite: false,
    destructive: false
  };
}

function triggerSpec(type, values) {
  if (type === "at") return { type, at: values.runAt };
  if (type === "after") return { type, delaySeconds: values.delaySeconds };
  if (type === "interval") return { type, startAt: values.runAt, intervalSeconds: values.intervalSeconds };
  if (type === "condition") return { type, condition: values.conditionSpec };
  return { type: "processExit", process: values.processSpec };
}

function canonicalTriggerType(value) {
  if (value === "once") return "at";
  if (value === "process") return "processExit";
  return value;
}

function validateTriggerShape(type, value) {
  const fields = {
    at: ["type", "at"],
    after: ["type", "delaySeconds"],
    interval: ["type", "startAt", "intervalSeconds"],
    condition: ["type", "condition"],
    processExit: ["type", "process"]
  }[type];
  rejectUnknown(value, new Set(fields), "trigger");
}

function legacyScheduleType(value) {
  if (["at", "after"].includes(value)) return "once";
  if (value === "processExit") return "process";
  return value;
}

function rejectUnsafeObserverScript(script) {
  const forbidden = /(^|[;&|]\s*)(curl|wget|ssh|scp|sftp|nc|netcat|git\s+push|rm|rmdir|mv|cp|chmod|chown|mkdir|touch|truncate|dd|tee|sed\s+-i|osascript|python\d*|ruby|perl|node|bash|zsh|sh)\b/i;
  if (forbidden.test(script) || /(^|[^<])>{1,2}(?!>)/.test(script)) {
    invalid("condition.script", "contains a write, remote, or destructive command; observers are read-only");
  }
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

function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function normalizeExpiration(input, now) {
  const hasTimestamp = input.expiresAt != null;
  const hasDuration = input.expiresAfterSeconds != null;
  if (hasTimestamp === hasDuration) {
    invalid("expiresAt", "requires exactly one of expiresAt or expiresAfterSeconds");
  }
  const expiresAt = hasTimestamp
    ? timestamp(input.expiresAt, "expiresAt")
    : new Date(now.getTime() + integer(input.expiresAfterSeconds, "expiresAfterSeconds", 1, 315_360_000) * 1000).toISOString();
  if (new Date(expiresAt).getTime() <= now.getTime()) invalid("expiresAt", "must be later than the creation time");
  return expiresAt;
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

function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function rejectUnknown(value, allowed, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(prefix ? `${prefix}.${unknown}` : unknown, "is not supported");
}

function invalid(field, reason) {
  const error = new TypeError(`${field} ${reason}.`);
  error.code = "INVALID_SCHEDULED_SESSION_TASK";
  error.field = field;
  throw error;
}
