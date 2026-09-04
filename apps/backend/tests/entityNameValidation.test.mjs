import assert from "node:assert/strict";
import test from "node:test";
import {
  validateEntityName,
  validateTaskInput,
  validateWorkInput
} from "../src/domain/workTaskValidation.mjs";

test("Work, Task, and Agent names accept only English letters, Han characters, and digits", () => {
  for (const value of ["Work任务2026", "ABCxyz123", "纯中文名称"]) {
    assert.equal(validateEntityName(value, "name", "Agent"), value);
  }
  assert.equal(
    validateWorkInput({ name: "Work甲1", contributorAgentIds: ["agent:one"] }).name,
    "Work甲1"
  );
  assert.equal(
    validateTaskInput({ workId: "work:one", title: "Task甲1" }).title,
    "Task甲1"
  );
});

test("entity names reject whitespace and punctuation without silently trimming", () => {
  for (const value of [
    "Two Words", "前后 空格", "name-with-dash", "name_with_underscore",
    "名称。", "名称/Task", "", "\n"
  ]) {
    assert.throws(
      () => validateEntityName(value, "name", "Agent"),
      (error) => error?.code === "INVALID_ENTITY_NAME" || error?.code === "INVALID_FIELD_TYPE"
    );
  }
});
