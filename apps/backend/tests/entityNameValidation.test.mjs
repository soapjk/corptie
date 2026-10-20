import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { generatedEntityTitle, isValidEntityTitle } from "../src/domain/entityTitlePolicy.mjs";
import {
  validateEntityName,
  validateTaskInput,
  validateWorkInput
} from "../src/domain/workTaskValidation.mjs";

test("Work, Task, and Agent names accept the unified title whitelist", () => {
  for (const value of ["Work任务2026", "ABCxyz123", "纯中文名称", "MarketCow-SDK", "策略_v2", "_123", "-名称"]) {
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
    "Two Words", "前后 空格", "1任务", "0Task", "Task\n", " Task", "Task ",
    "名称。", "名称/Task", "", "\n"
  ]) {
    assert.throws(
      () => validateEntityName(value, "name", "Agent"),
      (error) => error?.code === "INVALID_ENTITY_NAME" || error?.code === "INVALID_FIELD_TYPE"
    );
  }
});

test("backend and all Swift clients share the same Unicode and punctuation corpus", async () => {
  const corpus = JSON.parse(await readFile(new URL("../../../packages/CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/entity-title-policy.json", import.meta.url), "utf8"));
  for (const { value, valid } of corpus) {
    assert.equal(isValidEntityTitle(value), valid, JSON.stringify(value));
    if (valid) {
      assert.equal(validateTaskInput({ workId: "work:test", title: value }).title, value);
      assert.equal(validateWorkInput({ name: value, contributorAgentIds: ["agent:test"] }).name, value);
    } else {
      assert.throws(() => validateTaskInput({ workId: "work:test", title: value }));
      assert.throws(() => validateWorkInput({ name: value, contributorAgentIds: ["agent:test"] }));
    }
  }
  for (const value of ["123 project", "Task。", "%", "name.with space", "旧标题（测试）"]) {
    assert.ok(isValidEntityTitle(generatedEntityTitle(value)));
  }
  // Updates without a title must not revalidate or rewrite historical titles.
  assert.deepEqual(validateTaskInput({ description: "New description" }, "update"), { description: "New description" });
  assert.deepEqual(validateWorkInput({ description: "New description" }, "update"), { description: "New description" });
});
