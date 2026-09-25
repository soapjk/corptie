import assert from "node:assert/strict";
import test from "node:test";
import { captureClaudePlanCalls, settledClaudePlanUpdates } from "../src/adapters/claudePlanTools.mjs";

function assistant(id, name, input) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

function result(id, output, isError = false) {
  return { type: "user", tool_use_result: output, message: { content: [
    { type: "tool_result", tool_use_id: id, is_error: isError, content: JSON.stringify(output) }
  ] } };
}

test("Claude TodoWrite commits only a successful complete snapshot", () => {
  const pending = new Map();
  const failures = [];
  captureClaudePlanCalls(assistant("use:one", "TodoWrite", { todos: [
    { content: "Inspect", status: "in_progress", activeForm: "Inspecting" },
    { content: "Fix", status: "pending", activeForm: "Fixing" }
  ] }), pending, "turn:one");
  assert.deepEqual(settledClaudePlanUpdates(result("use:one", {}, true), pending,
    (call, reason) => failures.push([call.name, reason])), []);
  assert.deepEqual(failures, [["TodoWrite", "failed"]]);
  captureClaudePlanCalls(assistant("use:two", "TodoWrite", { todos: [
    { content: "Inspect", status: "completed", activeForm: "Inspecting" }
  ] }), pending, "turn:one");
  assert.deepEqual(settledClaudePlanUpdates(result("use:two", { newTodos: [
    { content: "Inspect", status: "completed", activeForm: "Inspecting" }
  ] }), pending), [{
    sourceCallId: "use:two", turnId: "turn:one",
    plan: { operation: "replace", explanation: null, steps: [{ text: "Inspect", status: "completed" }] }
  }]);

  captureClaudePlanCalls(assistant("use:missing", "TodoWrite", { todos: [
    { content: "Unconfirmed", status: "completed", activeForm: "Checking" }
  ] }), pending, "turn:one");
  const unavailable = [];
  assert.deepEqual(settledClaudePlanUpdates(result("use:missing", {}), pending,
    (call, reason) => unavailable.push([call.name, reason])), []);
  assert.deepEqual(unavailable, [["TodoWrite", "unavailable"]]);
});

test("parallel Claude tool results match each call without borrowing another output", () => {
  const pending = new Map();
  captureClaudePlanCalls({ type: "assistant", message: { content: [
    { type: "tool_use", id: "call:todo", name: "TodoWrite", input: { todos: [
      { content: "Inspect", status: "pending", activeForm: "Inspecting" }
    ] } },
    { type: "tool_use", id: "call:create", name: "TaskCreate", input: { subject: "Build", description: "Build" } }
  ] } }, pending, "turn:parallel");
  const updates = settledClaudePlanUpdates({ type: "user", tool_use_result: {
    newTodos: [{ content: "Wrong shared output", status: "completed" }]
  }, message: { content: [
    { type: "tool_result", tool_use_id: "call:todo", content: JSON.stringify({ newTodos: [
      { content: "Inspect", status: "completed", activeForm: "Inspecting" }
    ] }) },
    { type: "tool_result", tool_use_id: "call:create", content: JSON.stringify({ task: {
      id: "42", subject: "Build"
    } }) }
  ] } }, pending);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].plan.steps[0].text, "Inspect");
  assert.equal(updates[1].plan.step.stepId, "task:42");
});

test("Claude task ID comes from a successful create result, not the tool-use ID", () => {
  const pending = new Map();
  captureClaudePlanCalls(assistant("use:create", "TaskCreate", { subject: "Build UI", description: "..." }), pending, "turn:one");
  assert.deepEqual(settledClaudePlanUpdates(result("use:create", { task: { id: "7", subject: "Build UI" } }), pending)[0].plan, {
    operation: "upsert", planKey: "claude-tasks",
    step: { stepId: "task:7", text: "Build UI", status: "pending" }
  });
  captureClaudePlanCalls(assistant("use:update", "TaskUpdate", { taskId: "7", status: "in_progress" }), pending, "turn:one");
  assert.deepEqual(settledClaudePlanUpdates(result("use:update", { success: true, taskId: "7", updatedFields: ["status"] }), pending)[0].plan, {
    operation: "upsert", planKey: "claude-tasks",
    step: { stepId: "task:7", status: "inProgress" }
  });
  captureClaudePlanCalls(assistant("use:fail", "TaskUpdate", { taskId: "7", status: "completed" }), pending, "turn:one");
  assert.deepEqual(settledClaudePlanUpdates(result("use:fail", { success: false, taskId: "7" }), pending), []);
  captureClaudePlanCalls(assistant("use:delete", "TaskUpdate", { taskId: "7", status: "deleted" }), pending, "turn:one");
  assert.deepEqual(settledClaudePlanUpdates(result("use:delete", { success: true, taskId: "7", updatedFields: ["status"] }), pending)[0].plan, {
    operation: "remove", planKey: "claude-tasks", step: { stepId: "task:7" }
  });
  assert.deepEqual(settledClaudePlanUpdates(result("use:delete", { success: true, taskId: "7" }), pending), []);
});

test("Claude TaskUpdate projects only fields confirmed by its result", () => {
  const pending = new Map();
  captureClaudePlanCalls(assistant("use:partial", "TaskUpdate", {
    taskId: "7", subject: "New title", status: "completed"
  }), pending, "turn:one");
  const partial = settledClaudePlanUpdates(result("use:partial", {
    success: true, taskId: "7", updatedFields: ["subject"]
  }), pending);
  assert.deepEqual(partial[0].plan, {
    operation: "upsert", planKey: "claude-tasks", step: { stepId: "task:7", text: "New title" }
  });

  captureClaudePlanCalls(assistant("use:description", "TaskUpdate", {
    taskId: "7", description: "More detail", status: "completed"
  }), pending, "turn:one");
  const fallback = [];
  assert.deepEqual(settledClaudePlanUpdates(result("use:description", {
    success: true, taskId: "7", updatedFields: ["description"]
  }), pending, (call, reason) => fallback.push([call.sourceCallId, reason])), []);
  assert.deepEqual(fallback, [["use:description", "completed"]]);

  captureClaudePlanCalls(assistant("use:uncertain", "TaskUpdate", {
    taskId: "7", status: "completed"
  }), pending, "turn:one");
  assert.deepEqual(settledClaudePlanUpdates(result("use:uncertain", {
    success: true, taskId: "7"
  }), pending, (call, reason) => fallback.push([call.sourceCallId, reason])), []);
  assert.deepEqual(fallback.at(-1), ["use:uncertain", "unavailable"]);
});

test("Claude TaskList is a complete task snapshot with native task identities", () => {
  const pending = new Map();
  captureClaudePlanCalls(assistant("use:list", "TaskList", {}), pending, "turn:two");
  assert.deepEqual(settledClaudePlanUpdates(result("use:list", { tasks: [
    { id: "7", subject: "Build UI", status: "in_progress" },
    { id: "8", subject: "Test UI", status: "pending" }
  ] }), pending)[0].plan, {
    operation: "replace", planKey: "claude-tasks", explanation: null,
    steps: [
      { stepId: "task:7", text: "Build UI", status: "inProgress" },
      { stepId: "task:8", text: "Test UI", status: "pending" }
    ]
  });
});

test("bounded Claude plan correlation reports an evicted call instead of hiding it", () => {
  const pending = new Map();
  const evicted = [];
  for (let index = 0; index < 257; index++) {
    captureClaudePlanCalls(assistant(`use:${index}`, "TodoWrite", { todos: [] }),
      pending, "turn:one", (call) => evicted.push(call));
  }
  assert.equal(pending.size, 256);
  assert.deepEqual(evicted.map((call) => call.sourceCallId), ["use:0"]);
  assert.equal(pending.has("use:0"), false);
  assert.equal(pending.has("use:256"), true);
});
