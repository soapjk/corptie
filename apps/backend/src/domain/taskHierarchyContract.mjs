// Bounded, provider-neutral resource data shared by native Detail projections.
const text = { type: "string", maxLength: 512 };
const count = { type: "integer", minimum: 0 };
const nullable = value => ({ anyOf: [value, { type: "null" }] });
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const action = object({ available: { type: "boolean" }, reason: nullable(text) });
export const taskHierarchySummarySchema = object({
  version: { const: 1 }, rootTaskId: text, depth: { type: "integer", minimum: 0, maximum: 1 }, revision: count,
  childCount: count, completedChildCount: count, activeChildCount: count,
  deliveryWorktreeId: nullable(text), bindingRevision: nullable(count),
  actions: object({ createChild: action }),
  acceptance: object({ state: text, receiptId: nullable(text), testedHeadOid: nullable(text), reason: nullable(text) })
});
export const worktreeHierarchySchema = object({
  version: { const: 1 }, role: { enum: ["parent", "child"] }, taskId: text, rootTaskId: text,
  parentTaskId: nullable(text), parentWorktreeId: nullable(text), hierarchyRevision: count, bindingRevision: count,
  comparison: object({ kind: { enum: ["main", "parent"] }, worktreeId: text, branchName: nullable(text),
    headOid: nullable(text), ahead: nullable(count), behind: nullable(count), merged: nullable({ type: "boolean" }) }),
  childCount: count, integratedChildCount: nullable(count),
  actions: object({ createChild: action, mergeChildren: action, syncChildren: action, mergeToParent: action,
    syncFromParent: action, syncFromMain: action, promoteToMain: action })
});
