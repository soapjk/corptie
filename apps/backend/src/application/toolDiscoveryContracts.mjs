const DOMAIN_PROFILES = Object.freeze({
  artifacts: profile(
    ["artifact", "artifacts", "artifact management", "work artifact", "产物", "工件", "文档"],
    "corptie_artifact_search"
  ),
  collaboration: profile(
    [
      "collaboration", "channel", "peer session", "peer message", "send message", "@session",
      "task collaboration", "协作", "频道", "会话协作", "发送消息", "发消息", "@会话名"
    ],
    "corptie_collaboration_channel_open"
  ),
  "task-acceptance": profile(
    ["task acceptance", "acceptance", "bound task", "task definition", "work item acceptance", "验收", "任务验收", "绑定任务", "任务定义", "工作项验收"],
    "corptie_task_get_bound"
  ),
  "project-code": profile(
    ["project code", "code search", "source snapshot", "代码", "代码搜索", "源码快照"],
    "corptie_project_code_search"
  ),
  workspace: profile(
    ["workspace", "worktree", "repository workspace", "工作区", "工作树", "仓库"],
    "corptie_list_workspaces"
  ),
  memory: profile(
    ["memory", "remember", "recall", "记忆", "记住", "回忆"],
    "corptie_memory_search"
  ),
  skills: profile(
    ["skill", "skills", "agent skill", "技能", "能力包"],
    "corptie_skill_search"
  ),
  "scheduled-tasks": profile(
    [
      "scheduled-tasks", "scheduled task", "scheduled tasks", "automation", "automations",
      "schedule", "reminder", "long-running task", "background task", "background process",
      "process exit", "process completion", "completion wakeup", "wait for process",
      "自动化", "计划任务", "定时任务", "提醒", "长任务", "后台任务", "后台进程",
      "进程退出", "任务完成唤醒"
    ],
    "corptie_automations_create"
  ),
  platform: profile(
    ["platform", "platform administration", "Corptie administration", "平台", "平台管理"],
    "corptie_platform_capabilities"
  ),
  "work-chat": profile(
    ["work chat", "work context", "work agents", "工作对话", "工作上下文", "工作成员"],
    "corptie_work_context"
  )
});

const COMPATIBILITY = Object.freeze({
  corptie_scheduled_tasks_manage: Object.freeze({
    status: "compatibility",
    recommendedAlternative: "Use the operation-specific corptie_automations_* canonical tool.",
    fieldMappings: Object.freeze({
      task_id: "automation_id",
      "schedule_type.once": "schedule_type.at",
      "missed_policy.coalesce_once": "missed_policy.fireOnce"
    }),
    resultNormalization: "Legacy task_id and task-shaped results remain accepted; Automation responses expose automationId while retaining taskId compatibility."
  })
});

const EXAMPLE_OVERRIDES = Object.freeze({
  corptie_automations_create: Object.freeze({
    name: "One-time reminder",
    schedule_type: "after",
    delay_seconds: 60,
    expires_after_seconds: 3600,
    message: "Reminder triggered"
  }),
  corptie_scheduled_tasks_manage: Object.freeze({
    action: "create",
    name: "One-time reminder",
    schedule_type: "after",
    delay_seconds: 60,
    expires_after_seconds: 3600,
    message: "Reminder triggered"
  })
});

const READ_OPERATIONS = /(?:^|_)(?:get|list|search|read|discover|describe|capabilities|context|load)(?:_|$)/;

export function domainDiscoveryProfile(domainId) {
  return DOMAIN_PROFILES[domainId] ?? profile([domainId], null);
}

export function toolDiscoveryContract(entry, domainProfile = domainDiscoveryProfile(entry.domainId)) {
  const schema = entry.definition.inputSchema ?? { type: "object", properties: {}, additionalProperties: false };
  const compatibility = COMPATIBILITY[entry.canonicalName] ?? null;
  return Object.freeze({
    canonicalName: entry.canonicalName,
    description: entry.definition.description ?? "",
    aliases: entry.aliases,
    recommended: entry.canonicalName === domainProfile.recommendedTool,
    stability: compatibility?.status ?? "canonical",
    compatibility,
    sideEffect: sideEffect(entry.canonicalName),
    inputSchema: schema,
    fieldDescriptions: fieldDescriptions(schema),
    constraints: Object.freeze({
      required: Object.freeze([...(schema.required ?? [])]),
      conditional: Object.freeze([...(schema.allOf ?? [])]),
      alternatives: Object.freeze([...(schema.oneOf ?? schema.anyOf ?? [])])
    }),
    minimalExample: EXAMPLE_OVERRIDES[entry.canonicalName] ?? exampleForSchema(schema)
  });
}

export function searchableDomainText(domainId) {
  const value = domainDiscoveryProfile(domainId);
  return `${domainId} ${value.aliases.join(" ")}`;
}

function profile(aliases, recommendedTool) {
  return Object.freeze({ aliases: Object.freeze([...new Set(aliases)]), recommendedTool });
}

function sideEffect(name) {
  return !READ_OPERATIONS.test(name.replace(/^corptie_/, ""));
}

function fieldDescriptions(schema) {
  return Object.freeze(Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, property]) => [
    name,
    property.description ?? `${name.replaceAll("_", " ")} input.`
  ])));
}

function exampleForSchema(schema, propertyName = null) {
  if (schema?.const !== undefined) return schema.const;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema?.oneOf) && schema.oneOf.length > 0) return exampleForSchema(schema.oneOf[0], propertyName);
  if (Array.isArray(schema?.anyOf) && schema.anyOf.length > 0) return exampleForSchema(schema.anyOf[0], propertyName);
  const type = Array.isArray(schema?.type) ? schema.type.find((value) => value !== "null") : schema?.type;
  if (type === "object" || schema?.properties) {
    const result = {};
    addRequired(result, schema, propertyName);
    const minimumProperties = Math.max(0, schema.minProperties ?? 0);
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (Object.keys(result).length >= minimumProperties) break;
      if (!Object.hasOwn(result, name)) result[name] = exampleForSchema(property, name);
    }
    for (const rule of schema.allOf ?? []) applyRule(result, rule);
    return result;
  }
  if (type === "array") {
    return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () => exampleForSchema(schema.items ?? {}));
  }
  if (type === "integer" || type === "number") return Math.max(schema.minimum ?? 1, 1);
  if (type === "boolean") return true;
  return exampleString(propertyName, schema);
}

function addRequired(target, schema) {
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(target, name)) target[name] = exampleForSchema(schema.properties?.[name] ?? {}, name);
  }
}

function applyRule(target, rule) {
  if (rule.if) {
    if (matchesSimple(target, rule.if)) addRequired(target, rule.then ?? {});
    else addRequired(target, rule.else ?? {});
    const branch = (matchesSimple(target, rule.if) ? rule.then : rule.else)?.oneOf?.[0];
    if (branch) addRequired(target, branch);
    return;
  }
  const branch = rule.oneOf?.[0] ?? rule.anyOf?.[0];
  if (branch) addRequired(target, branch);
  addRequired(target, rule);
}

function matchesSimple(value, schema) {
  for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) return false;
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (property.const !== undefined && value[name] !== property.const) return false;
  }
  return true;
}

function exampleString(name, schema) {
  if (schema?.pattern === "^[a-f0-9]{64}$" || name?.includes("hash")) return "0".repeat(64);
  if (schema?.pattern?.includes("artifact_reference") || name === "reference_id") return "artifact_reference:example";
  if (schema?.pattern?.includes("artifact") || name === "artifact_id") return "artifact:example";
  if (name?.endsWith("task_id") || name === "taskId" || name === "targetTaskId") return "task:example";
  if (name?.includes("session_id") || name === "logicalSessionId") return "session:example";
  if (name === "workId") return "work:example";
  if (name === "memory_id") return "memory:example";
  if (name === "automation_id") return "automation:example";
  if (name === "run_at" || name === "expires_at") return "2099-01-01T00:00:00.000Z";
  if (name === "idempotency_key" || name === "idempotencyKey") return "example-operation-1";
  if (name === "title") return "Example title";
  if (name === "name") return "Example name";
  if (name === "content") return "Example content";
  if (name === "reason") return "Example reason";
  if (name === "criterion") return "Example acceptance criterion";
  if (name === "summary") return "Reproducible verification passed";
  if (name === "reference") return "npm test";
  return "example";
}
