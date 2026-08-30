import assert from "node:assert/strict";
import test from "node:test";
import { HostToolCatalog, TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD } from "../src/application/hostToolCatalog.mjs";
import { buildToolExposurePlan } from "../src/application/toolExposurePlan.mjs";

const catalog = new HostToolCatalog([
  {
    id: "artifacts", domainId: "artifacts",
    tools: [{ name: "corptie_artifact_get", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    execute: () => null
  },
  {
    id: "memory", domainId: "memory",
    tools: [{ name: "corptie_memory_search", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    execute: () => null
  }
]);

test("public first-Turn bootstrap is search/load only and Worker adds only Artifact domain", () => {
  const capability = { appendInPlace: true, bootstrapAttach: true, capabilityRevision: "native:1" };
  const normal = buildToolExposurePlan({ catalog, desiredDomains: [], capabilities: capability, phase: "create" });
  const worker = buildToolExposurePlan({ catalog, desiredDomains: ["artifacts"], capabilities: capability, phase: "create" });
  assert.deepEqual(normal.providerDefinitions.map((tool) => tool.name), [TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD]);
  assert.deepEqual(worker.providerDefinitions.map((tool) => tool.name), [
    TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD, "corptie_artifact_get"
  ]);
  assert.equal(worker.providerDefinitions.some((tool) => tool.name === "corptie_memory_search"), false);
});

test("gateway bootstrap never duplicates canonical Artifact schema", () => {
  const plan = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "create",
    capabilities: { bootstrapAttach: true, restrictedGateway: true, capabilityRevision: "gateway:1" }
  });
  assert.equal(plan.providerDefinitions.filter((tool) => tool.name === "corptie_artifact_get").length, 0);
  assert.equal(plan.providerDefinitions.filter((tool) => tool.name === "corptie_tool_call").length, 1);
  assert.equal(plan.ownership.corptie_artifact_get.surface, "restricted_gateway");
});
