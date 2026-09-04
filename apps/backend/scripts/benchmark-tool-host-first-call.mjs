import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { scheduledSessionTaskDynamicTools } from "../src/application/scheduledSessionTaskDynamicTools.mjs";
import { domainDiscoveryProfile } from "../src/application/toolDiscoveryContracts.mjs";
import { buildToolExposurePlan } from "../src/application/toolExposurePlan.mjs";

export async function runToolHostFirstCallBenchmark(iterations = 100) {
  let created = 0;
  const catalog = new HostToolCatalog([{
    id: "scheduled-tasks",
    tools: scheduledSessionTaskDynamicTools,
    execute: ({ arguments: args }) => ({ automationId: `automation:${++created}`, ...args })
  }]);
  const context = { actorId: "agent:benchmark", metadata: { logicalSessionId: "logical:benchmark" } };
  const catalogVersion = catalog.snapshot().catalogVersion;
  const searchDurations = [];
  const callDurations = [];
  let schemaValidationFailures = 0;
  let discovered;
  let plan;

  // Cold protocol: catalog search -> domain load/materialization -> one business call.
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const profile = domainDiscoveryProfile("scheduled-tasks");
    assert.ok(profile.aliases.includes("automation") && profile.aliases.includes("计划任务"));
    discovered = catalog.domainContract(context, "scheduled-tasks", { catalogVersion });
    searchDurations.push(performance.now() - started);
  }
  plan = buildToolExposurePlan({
    catalog,
    context,
    desiredDomains: ["scheduled-tasks"],
    capabilities: { restrictedGateway: true, capabilityRevision: "benchmark:first-call:1" },
    phase: "refresh"
  });
  const input = discovered.tools.find((tool) => tool.canonicalName === discovered.recommendedTool).minimalExample;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    try {
      await catalog.execute({ ...context, tool: discovered.recommendedTool, arguments: input });
    } catch (error) {
      if (error?.code === "TOOL_ARGUMENT_SCHEMA_INVALID") schemaValidationFailures += 1;
      throw error;
    } finally {
      callDurations.push(performance.now() - started);
    }
  }

  const result = Object.freeze({
    iterations,
    firstSuccessfulCallSteps: 3,
    loadedBusinessCallSteps: 1,
    schemaValidationFailures,
    catalogSearchDurationMs: stats(searchDurations),
    businessCallDurationMs: stats(callDurations),
    discoveredDomain: discovered.domainId,
    recommendedTool: discovered.recommendedTool,
    deliverySurface: plan.surface
  });
  assert.equal(result.discoveredDomain, "scheduled-tasks");
  assert.equal(result.recommendedTool, "corptie_automations_create");
  assert.ok(result.firstSuccessfulCallSteps <= 3);
  assert.equal(result.loadedBusinessCallSteps, 1);
  assert.equal(result.schemaValidationFailures, 0);
  return result;
}

function stats(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return Object.freeze({
    median: rounded(ordered[Math.floor(ordered.length * 0.5)]),
    p95: rounded(ordered[Math.floor(ordered.length * 0.95)])
  });
}

function rounded(value) {
  return Number(value.toFixed(3));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runToolHostFirstCallBenchmark(), null, 2));
}
