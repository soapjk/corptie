import assert from "node:assert/strict";
import test from "node:test";
import { executionPlanItem, finishExecutionPlan, replaceExecutionPlan } from "../src/application/executionPlanProjection.mjs";

const context = { planId: "plan:one", updatedAt: "2026-09-24T00:00:00Z" };

test("a cleared checklist stays in history without an empty 0/0 summary", () => {
  const plan = replaceExecutionPlan(null, { operation: "replace", steps: [] }, context);
  const item = executionPlanItem(plan, { turnId: "turn:one", turnStatus: "inProgress",
    createdAt: context.updatedAt });
  assert.equal(item.text, "No plan steps");
  assert.equal(item.status, "running");
  assert.deepEqual(JSON.parse(item.rawMetadataJSON).executionPlan.steps, []);
});

test("a 200-step plan with duplicate labels preserves every distinct identity", () => {
  const steps = Array.from({ length: 200 }, () => ({ text: "Inspect", status: "pending" }));
  const first = replaceExecutionPlan(null, { operation: "replace", steps }, context);
  assert.equal(first.steps.length, 200);
  assert.equal(new Set(first.steps.map((step) => step.stepId)).size, 200);
  const updated = replaceExecutionPlan(first, { operation: "replace",
    steps: steps.map((step, ordinal) => ({ ...step, status: ordinal % 2 ? "completed" : "inProgress" }))
  }, context);
  assert.deepEqual(updated.steps.map((step) => step.stepId), first.steps.map((step) => step.stepId));
  assert.equal(updated.steps[199].status, "completed");
  assert.equal(replaceExecutionPlan(updated, { operation: "replace",
    steps: updated.steps.map(({ text, status }) => ({ text, status })) }, context), null);
  assert.equal(replaceExecutionPlan(updated, { operation: "replace", steps: [...steps, steps[0]] }, context), undefined);
});

test("malformed or oversized plan explanations cannot enter the shared projection", () => {
  for (const explanation of [{ nested: "unexpected" }, "x".repeat(4_001)]) {
    assert.equal(replaceExecutionPlan(null, { operation: "replace", explanation,
      steps: [{ text: "Inspect", status: "pending" }] }, context), undefined);
  }
  assert.equal(replaceExecutionPlan(null, { operation: "replace", explanation: "Brief context",
    steps: [{ text: "Inspect", status: "pending" }] }, context).explanation, "Brief context");
});

test("native step identities do not consume a text-matched legacy identity", () => {
  const first = replaceExecutionPlan(null, { operation: "replace", steps: [
    { text: "Inspect", status: "pending" }
  ] }, context);
  const updated = replaceExecutionPlan(first, { operation: "replace", steps: [
    { stepId: "task:7", text: "Inspect", status: "completed" },
    { text: "Inspect", status: "pending" }
  ] }, context);
  assert.deepEqual(updated.steps.map((step) => step.stepId), ["task:7", first.steps[0].stepId]);
});

test("a uniquely surrounded Codex rename keeps its identity but takes the new status", () => {
  const first = replaceExecutionPlan(null, { operation: "replace", steps: [
    { text: "Inspect", status: "completed" },
    { text: "Implement", status: "pending" },
    { text: "Verify", status: "pending" }
  ] }, context);
  const renamed = replaceExecutionPlan(first, { operation: "replace", steps: [
    { text: "Inspect", status: "completed" },
    { text: "Implement the shared checklist", status: "inProgress" },
    { text: "Verify", status: "pending" }
  ] }, context);
  assert.deepEqual(renamed.steps.map((step) => step.stepId), first.steps.map((step) => step.stepId));
  assert.equal(renamed.steps[1].status, "inProgress");
  assert.equal(renamed.steps[1].text, "Implement the shared checklist");
});

test("ambiguous Codex edits allocate new identities rather than attaching old completion", () => {
  const first = replaceExecutionPlan(null, { operation: "replace", steps: [
    { text: "Inspect", status: "completed" },
    { text: "Implement", status: "completed" },
    { text: "Verify", status: "pending" }
  ] }, context);
  const changed = replaceExecutionPlan(first, { operation: "replace", steps: [
    { text: "Inspect", status: "completed" },
    { text: "Review code", status: "pending" },
    { text: "Review tests", status: "pending" }
  ] }, context);
  assert.equal(changed.steps[0].stepId, first.steps[0].stepId);
  assert.notEqual(changed.steps[1].stepId, first.steps[1].stepId);
  assert.notEqual(changed.steps[2].stepId, first.steps[2].stepId);
  assert.deepEqual(changed.steps.slice(1).map((step) => step.status), ["pending", "pending"]);

  const single = replaceExecutionPlan(null, { operation: "replace", steps: [
    { text: "Old", status: "completed" }
  ] }, context);
  const singleRename = replaceExecutionPlan(single, { operation: "replace", steps: [
    { text: "New", status: "pending" }
  ] }, context);
  assert.notEqual(singleRename.steps[0].stepId, single.steps[0].stepId);
});

test("settling a plan never leaves an unconfirmed step visibly in progress", () => {
  const active = replaceExecutionPlan(null, { operation: "replace", steps: [
    { text: "Done", status: "completed" },
    { text: "Still running", status: "inProgress" },
    { text: "Later", status: "pending" }
  ] }, context);
  const failed = finishExecutionPlan(active, "failed", context.updatedAt);
  assert.equal(failed.lifecycle, "failed");
  assert.deepEqual(failed.steps.map((step) => step.status), ["completed", "unknown", "pending"]);
  assert.equal(failed.revision, active.revision + 1);
  assert.equal(finishExecutionPlan(failed, "failed", context.updatedAt), null);
});
