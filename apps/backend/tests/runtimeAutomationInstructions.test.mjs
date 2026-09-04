import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runtime instructions route long non-interactive work through background Automation wakeup", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const instruction = source.split("\n").find((line) => line.includes(
    "for non-interactive work expected to exceed two minutes"
  ));

  assert.ok(instruction);
  assert.match(instruction, /do not continuously poll/);
  assert.match(instruction, /start it in the background/);
  assert.match(instruction, /processExit or condition trigger/);
  assert.match(instruction, /wake the current Session/);
  assert.match(instruction, /search the Tool Catalog for scheduled-tasks/);
  assert.doesNotMatch(instruction, /expected_start_time|expires_after_seconds|no-restart/);
});
