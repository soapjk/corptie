import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { buildToolExposurePlan } from "../src/application/toolExposurePlan.mjs";

const namespaces = Array.from({ length: 10 }, (_, domainIndex) => ({
  id: `domain-${domainIndex}`,
  tools: Array.from({ length: 20 }, (_, toolIndex) => ({
    name: `corptie_domain_${domainIndex}_tool_${toolIndex}`,
    description: "Representative deferred Tool Host operation with strict bounded input.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 1000 } },
      required: ["query"],
      additionalProperties: false
    }
  })),
  execute: () => null
}));
const catalog = new HostToolCatalog(namespaces);
const eagerBytes = Buffer.byteLength(JSON.stringify(catalog.definitions()));
const bootstrapBytes = Buffer.byteLength(JSON.stringify(catalog.bootstrapDefinitions()));
const reduction = 1 - (bootstrapBytes / eagerBytes);

const searchDurations = run(2_000, () => {
  [...catalog.domains()].filter(([domainId]) => domainId.includes("domain"));
});
const loadDurations = run(2_000, () => buildToolExposurePlan({
  catalog,
  desiredDomains: ["domain-1"],
  phase: "refresh",
  capabilities: { restrictedGateway: true, capabilityRevision: "benchmark:1" }
}));
const result = {
  eagerBytes, bootstrapBytes, bootstrapReductionPercent: Number((reduction * 100).toFixed(2)),
  catalogSearchP95Ms: p95(searchDurations), cachedDomainLoadP95Ms: p95(loadDurations)
};
assert.ok(reduction >= 0.8, `bootstrap reduction ${result.bootstrapReductionPercent}% is below 80%`);
assert.ok(result.catalogSearchP95Ms < 20, `catalog search p95 ${result.catalogSearchP95Ms}ms is above 20ms`);
assert.ok(result.cachedDomainLoadP95Ms < 10, `cached domain load p95 ${result.cachedDomainLoadP95Ms}ms is above 10ms`);
console.log(JSON.stringify(result));

function run(iterations, operation) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation();
    values.push(performance.now() - started);
  }
  return values;
}

function p95(values) {
  return Number([...values].sort((left, right) => left - right)[Math.floor(values.length * 0.95)].toFixed(3));
}
