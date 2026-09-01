import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { historicalProviderSessionUnavailable } from "../src/application/taskSessionRepairPolicy.mjs";

test("historical Provider rollout absence remains classifiable without authorizing Session replacement", () => {
  assert.equal(historicalProviderSessionUnavailable(
    '{"message":"failed to resolve rollout path `/old/runtime/sessions/rollout-thread-a.jsonl`: file does not exist"}'
  ), true);
  assert.equal(historicalProviderSessionUnavailable(
    '{"message":"failed to resolve rollout path `/old/runtime/sessions/rollout-thread-a.jsonl`: permission denied"}'
  ), false);
});

test("Provider failure never replaces a Task Session outside explicit Recovery", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /selfRepairTaskSession/);
  assert.doesNotMatch(source, /repairBrokenTaskSessionsAtStartup/);
  assert.doesNotMatch(source, /source:\s*["']self-repair["']/);
  assert.match(source, /if \(!shouldRetryBusy\) throw error;/);
  assert.match(source, /unavailable\.code = "PROVIDER_BINDING_RECOVERY_REQUIRED"/);
});
