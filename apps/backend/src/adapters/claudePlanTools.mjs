const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"]);

export function isClaudePlanTool(name) {
  return PLAN_TOOLS.has(name);
}

export function captureClaudePlanCalls(message, pending, turnId, onEvicted = () => {}) {
  const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
  for (const block of blocks) {
    if (block?.type !== "tool_use" || !PLAN_TOOLS.has(block.name)
      || typeof block.id !== "string" || !block.id || !isObject(block.input)) continue;
    if (!pending.has(block.id) && pending.size >= 256) {
      const oldestId = pending.keys().next().value;
      onEvicted(pending.get(oldestId));
      pending.delete(oldestId);
    }
    pending.set(block.id, { sourceCallId: block.id, name: block.name, input: block.input, turnId });
  }
}

export function settledClaudePlanUpdates(message, pending, onUnmapped = () => {}) {
  const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
  const results = blocks.filter((block) => block?.type === "tool_result");
  const updates = [];
  for (const block of results) {
    const call = pending.get(block.tool_use_id);
    if (!call) continue;
    pending.delete(block.tool_use_id);
    if (block.is_error === true) {
      onUnmapped(call, "failed");
      continue;
    }
    const output = results.length === 1 ? structuredOutput(message.tool_use_result, block.content) : structuredOutput(null, block.content);
    const plan = planFromSuccessfulTool(call, output);
    if (plan) updates.push({ sourceCallId: block.tool_use_id, turnId: call.turnId, plan });
    else if (plan === false) onUnmapped(call, "completed");
    else onUnmapped(call, "unavailable");
  }
  return updates;
}

function planFromSuccessfulTool(call, output) {
  if (call.name === "TodoWrite") {
    // A successful tool_result without the authoritative post-update list is
    // not proof that the requested snapshot was actually committed.
    const todos = output?.newTodos;
    if (!Array.isArray(todos) || todos.length > 200) return null;
    const steps = todos.map((todo) => ({
      text: todo?.content,
      status: mapStatus(todo?.status)
    }));
    if (steps.some((step) => !validText(step.text) || !step.status)) return null;
    return { operation: "replace", explanation: null, steps };
  }
  if (call.name === "TaskCreate") {
    const id = output?.task?.id;
    const text = output?.task?.subject ?? call.input.subject;
    if (!validId(id) || !validText(text)) return null;
    return { operation: "upsert", planKey: "claude-tasks", step: {
      stepId: `task:${id}`, text, status: "pending"
    } };
  }
  if (call.name === "TaskUpdate") {
    if (output?.success !== true || output?.taskId !== call.input.taskId || !validId(call.input.taskId)) return null;
    if (!Array.isArray(output.updatedFields) || output.updatedFields.some((field) => typeof field !== "string")) return null;
    const hasStatus = output.updatedFields.includes("status");
    const hasSubject = output.updatedFields.includes("subject");
    // A successful tool call can update only description, ownership or other
    // fields. Do not project requested plan fields the result did not confirm.
    if (!hasStatus && !hasSubject) return false;
    const requestedStatus = hasStatus ? call.input.status : null;
    const status = requestedStatus === "deleted" ? null : mapStatus(requestedStatus);
    if (hasStatus && requestedStatus !== "deleted" && !status) return null;
    if (hasStatus && output.statusChange?.to != null && output.statusChange.to !== requestedStatus) return null;
    if (hasSubject && !validText(call.input.subject)) return null;
    return { operation: requestedStatus === "deleted" ? "remove" : "upsert", planKey: "claude-tasks", step: {
      stepId: `task:${call.input.taskId}`,
      ...(hasSubject ? { text: call.input.subject } : {}),
      ...(status ? { status } : {})
    } };
  }
  if (call.name === "TaskList") {
    if (!Array.isArray(output?.tasks) || output.tasks.length > 200) return null;
    if (output.tasks.some((task) => !validId(task?.id))) return null;
    const steps = output.tasks.map((task) => ({
      stepId: `task:${task?.id}`,
      text: task?.subject,
      status: mapStatus(task?.status)
    }));
    if (steps.some((step) => !validText(step.text) || !step.status)) return null;
    return { operation: "replace", planKey: "claude-tasks", explanation: null, steps };
  }
  return null;
}

function structuredOutput(value, content) {
  if (isObject(value)) return value;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.find((part) => part?.type === "text")?.text : null;
  if (typeof text !== "string" || text.length > 100_000) return null;
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapStatus(status) {
  if (status === "pending") return "pending";
  if (status === "in_progress") return "inProgress";
  if (status === "completed") return "completed";
  return null;
}

function validText(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2_000;
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/\s/.test(value);
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
