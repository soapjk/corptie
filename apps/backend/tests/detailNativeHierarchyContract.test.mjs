import assert from "node:assert/strict";
import test from "node:test";
import { projectNativeBusinessDocument, nativeBusinessModuleCard, nativeBusinessEnvelope } from "../src/application/detailNativeBusinessProjection.mjs";
import { validateNativeBusinessDocument } from "../src/application/detailNativeBusinessContract.mjs";

const action = available => ({ available, reason: available ? null : "TASK_MAX_DEPTH_EXCEEDED" });
const summary = {
  version: 1, rootTaskId: "task:parent", depth: 1, revision: 4, childCount: 0,
  completedChildCount: 0, activeChildCount: 0, deliveryWorktreeId: "worktree:child", bindingRevision: 1,
  actions: { createChild: action(false) },
  acceptance: { state: "not_applicable", receiptId: null, testedHeadOid: null, reason: null }
};
const hierarchy = {
  version: 1, role: "child", taskId: "task:child", rootTaskId: "task:parent",
  parentTaskId: "task:parent", parentWorktreeId: "worktree:parent", hierarchyRevision: 4, bindingRevision: 1,
  comparison: { kind: "parent", worktreeId: "worktree:parent", branchName: "delivery-parent", headOid: "a".repeat(40), ahead: 2, behind: 1, merged: false },
  childCount: 0, integratedChildCount: null,
  actions: { createChild: action(false), mergeChildren: action(false), syncChildren: action(false),
    mergeToParent: action(true), syncFromParent: action(true), syncFromMain: action(false), promoteToMain: action(false) }
};

test("native Task card retains hierarchy and navigation to the actual parent Session", () => {
  const scope = { session: { sessionKind: "worker" }, logicalSessionId: "logical:child",
    task: { id: "task:child", title: "Child", parent_task_id: "task:parent", revision: 1 },
    taskHierarchy: summary, parentSessionId: "logical:parent" };
  const document = projectNativeBusinessDocument(scope, {}, "test-generation");
  const card = document.cards.find(card => card.kind === "taskInfo");
  assert.deepEqual(card.data.hierarchy, summary);
  assert.equal(card.data.parentTaskId, "task:parent");
  assert.equal(card.data.parentSessionId, "logical:parent");
  assert.ok(card.actions.some(action => action.operation === "resource.open" && action.target.id === "logical:parent" && action.target.resourceType === "session"));
  const invalid = structuredClone(document);
  invalid.cards.find(card => card.kind === "taskInfo").data.hierarchy.providerSpecificActor = "not-allowed";
  assert.throws(() => validateNativeBusinessDocument(invalid), { code: "DETAIL_BUSINESS_INVALID" });
});

test("native Worktree card preserves parent comparison and rejects undeclared hierarchy fields", () => {
  const card = nativeBusinessModuleCard("worktree", { state: "ready", data: {
    attached: true, workspace: { id: "worktree:child" }, mainBranch: "main", hierarchy
  } });
  const document = nativeBusinessEnvelope("logical:child", "test-generation", [card]);
  assert.deepEqual(document.cards[0].data.hierarchy, hierarchy);
  assert.equal(document.cards[0].data.hierarchy.comparison.kind, "parent");
  const oldPayload = structuredClone(document); delete oldPayload.cards[0].data.hierarchy;
  assert.equal(validateNativeBusinessDocument(oldPayload), oldPayload);
  const invalid = structuredClone(document); invalid.cards[0].data.hierarchy.comparison.absolutePath = "/private/host";
  assert.throws(() => validateNativeBusinessDocument(invalid), { code: "DETAIL_BUSINESS_INVALID" });
});
