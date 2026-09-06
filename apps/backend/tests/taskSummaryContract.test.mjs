import assert from "node:assert/strict";
import test from "node:test";
import { validateTaskSummaryOutput } from "../src/application/taskSummaryContract.mjs";

const context = { allowedSources: new Set(["task:definition:2", "message:1"]) };
const example = { focus: "调整消息卡片", progress: "已实现边界约束，待用户查看。",
  intervention: "required", reason: "需要人工确认布局。", nextAction: "检查消息是否仍越界。", sourceRefs: ["message:1"] };

test("summary validates bounded structured output with scoped sources", () => {
  const result = validateTaskSummaryOutput(JSON.stringify(example), context);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.intervention, "required");
});

test("summary cannot smuggle goal, acceptance, lifecycle or arbitrary source updates", () => {
  for (const field of ["goal", "acceptanceCriteria", "lifecycleState", "tools"]) {
    assert.throws(() => validateTaskSummaryOutput(JSON.stringify({ ...example, [field]: "done" }), context), { code: "TASK_SUMMARY_INVALID_OUTPUT" });
  }
  assert.throws(() => validateTaskSummaryOutput(JSON.stringify({ ...example, sourceRefs: ["another-task:message"] }), context), { code: "TASK_SUMMARY_INVALID_OUTPUT" });
});

test("partial context cannot certify no intervention", () => {
  const result = validateTaskSummaryOutput(JSON.stringify({ ...example, intervention: "not_required", nextAction: "", reason: "" }), { ...context, incomplete: true });
  assert.equal(result.intervention, "unknown");
});

test("required intervention needs a concrete next action", () => {
  assert.throws(() => validateTaskSummaryOutput(JSON.stringify({ ...example, nextAction: "" }), context), { code: "TASK_SUMMARY_INVALID_OUTPUT" });
});
