import assert from "node:assert/strict";
import test from "node:test";
import { runToolHostFirstCallBenchmark } from "../scripts/benchmark-tool-host-first-call.mjs";

test("cold and loaded Automation discovery benchmark stays within the first-call round-trip budget", async () => {
  const result = await runToolHostFirstCallBenchmark(20);
  assert.equal(result.firstSuccessfulCallSteps, 3);
  assert.equal(result.loadedBusinessCallSteps, 1);
  assert.equal(result.schemaValidationFailures, 0);
  assert.equal(result.discoveredDomain, "scheduled-tasks");
  assert.equal(result.recommendedTool, "corptie_automations_create");
  assert.ok(Number.isFinite(result.catalogSearchDurationMs.p95));
  assert.ok(Number.isFinite(result.businessCallDurationMs.p95));
});
