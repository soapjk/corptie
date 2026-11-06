const inputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["get", "create", "add", "edit", "remove", "move", "status", "assign", "unassign", "close"] },
    expectedRevision: { type: "integer", minimum: 0 }, operationId: { type: "string", minLength: 1, maxLength: 200 },
    itemIds: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } },
    taskId: { type: "string", maxLength: 200 }, dispatchId: { type: "string", maxLength: 200 },
    itemId: { type: "string" }, text: { type: "string", maxLength: 2000 }, condition: { type: "string", maxLength: 2000 },
    status: { type: "string", enum: ["pending", "inProgress", "completed", "blocked"] }, reason: { type: "string", maxLength: 2000 },
    position: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 },
    steps: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", additionalProperties: false,
      properties: { text: { type: "string", minLength: 1, maxLength: 2000 }, condition: { type: "string", maxLength: 2000 } }, required: ["text"] } }
  }, required: ["action"],
  allOf: [{ if: { properties: { action: { enum: ["create", "add", "edit", "remove", "move", "status", "assign", "unassign", "close"] } }, required: ["action"] },
    then: { required: ["expectedRevision", "operationId"] } },
    { if: { properties: { action: { enum: ["assign", "unassign"] } }, required: ["action"] },
      then: { anyOf: [{ required: ["itemId"] }, { required: ["itemIds"] }] },
      else: { not: { anyOf: [{ required: ["taskId"] }, { required: ["dispatchId"] }, { required: ["itemIds"] }] } } },
    { if: { properties: { action: { const: "assign" } }, required: ["action"] },
      then: { anyOf: [{ required: ["taskId"] }, { required: ["dispatchId"] }] } } ]
};
export const executionChecklistDynamicTools = Object.freeze([{
  type: "function", name: "corptie_execution_checklist_manage", deferLoading: false, inputSchema,
  description: "Maintain the finite execution checklist for this Session's bound Task. First get, then create a checklist of authorized actions with completion conditions. After each item use status completed; undo with pending. Use close to hide the current batch without stopping work. Use create for a new batch; it closes and preserves the previous batch. Supports add/edit/remove/move at any time; assign/unassign links itemIds to an existing child taskId or dispatchId from corptie_task_dispatch. Assigning does not dispatch work or complete items; edits do not expand execution authority. Updates return remaining items. Do not rebuild after every item: keep final verification as an item. Completion is a progress claim, not Task acceptance. The checklist records progress only and does not control execution or impose continuation budgets."
}]);
export function callExecutionChecklistTool(service, input) {
  const { task, logical, session } = service.scope(input.metadata);
  const args = input.arguments ?? {};
  const compact = result => {
    const value = result.checklist;
    const offset = args.action === "get" ? args.offset ?? 0 : 0;
    const limit = args.action === "get" ? args.limit ?? 20 : 8;
    const display = value.planId ? service.display(value) : value;
    return { ...result, checklist: { ...display, steps: value.steps.slice(offset, offset + limit) },
      totalSteps: value.steps.length, remainingCount: result.remaining.length,
      remaining: result.remaining.slice(0, 8),
      nextOffset: offset + limit < value.steps.length ? offset + limit : null };
  };
  if (args.action === "get") return compact(service.result(service.read(task.id) ?? { steps: [], revision: 0, lifecycle: "not_created" }));
  return compact(service.mutate(task.id, args, { model: true, logicalSessionId: logical.logicalSessionId,
    turnId: session.external?.activeTurnId ?? session.rawStatus?.activeTurnId, bindingId: logical.activeBinding.bindingId }));
}
