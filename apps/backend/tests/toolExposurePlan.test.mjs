import assert from "node:assert/strict";
import test from "node:test";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import {
  assertUniqueToolSurfaces,
  buildToolExposurePlan
} from "../src/application/toolExposurePlan.mjs";

const catalog = new HostToolCatalog([{
  id: "artifacts",
  tools: [{ name: "corptie_artifact_create", inputSchema: { type: "object" } }],
  execute: () => null
}]);

test("ExposurePlan selects one surface from real capability facts", () => {
  const native = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "refresh",
    capabilities: { appendInPlace: true, capabilityRevision: "native:1" }
  });
  const mcp = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "refresh",
    capabilities: { generatedMcpRefresh: true, capabilityRevision: "mcp:1" }
  });
  const gateway = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "refresh",
    capabilities: { restrictedGateway: true, capabilityRevision: "gateway:1" }
  });
  assert.equal(native.ownership.corptie_artifact_create.surface, "native_dynamic");
  assert.equal(mcp.ownership.corptie_artifact_create.surface, "generated_authenticated_mcp");
  assert.equal(gateway.ownership.corptie_artifact_create.surface, "restricted_gateway");
  assert.equal(gateway.providerDefinitions.some((tool) => tool.name === "corptie_artifact_create"), false);
  assert.equal(gateway.providerDefinitions.some((tool) => tool.name === "corptie_tool_call"), true);
});

test("ExposurePlan fails closed on duplicate delivery ownership", () => {
  const plan = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "refresh",
    capabilities: { restrictedGateway: true, capabilityRevision: "gateway:1" }
  });
  assert.throws(() => assertUniqueToolSurfaces([plan, plan]), {
    code: "TOOL_DELIVERY_SURFACE_CONFLICT"
  });
});

test("ExposurePlan reports a stable conflict across native, generated MCP, and gateway surfaces", () => {
  const native = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "refresh",
    capabilities: { appendInPlace: true, capabilityRevision: "native:1" }
  });
  const mcp = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "refresh",
    capabilities: { generatedMcpRefresh: true, capabilityRevision: "mcp:1" }
  });
  const gateway = buildToolExposurePlan({
    catalog, desiredDomains: ["artifacts"], phase: "refresh",
    capabilities: { restrictedGateway: true, capabilityRevision: "gateway:1" }
  });
  for (const pair of [[native, mcp], [native, gateway], [mcp, gateway]]) {
    assert.throws(() => assertUniqueToolSurfaces(pair), (error) => {
      assert.equal(error.code, "TOOL_DELIVERY_SURFACE_CONFLICT");
      assert.equal(error.canonicalName, "corptie_artifact_create");
      assert.notEqual(error.existing.surface, error.conflicting.surface);
      return true;
    });
  }
});
