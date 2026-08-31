import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { confirmOrRestoreCodexToolPlan } from "../src/application/codexToolPlanConfirmation.mjs";

const definitions = [{
  name: "corptie_tool_call",
  description: "Restricted gateway",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
}];
const binding = {
  logicalSessionId: "logical:one",
  providerBindingId: "binding:one",
  providerSessionId: "thread:one"
};
const plan = {
  providerDefinitions: definitions,
  providerDefinitionsHash: "unused-by-legacy-proof",
  exposurePlanHash: "exposure:one",
  bootstrapSchemaHash: "bootstrap:one",
  refreshMode: "restricted_gateway"
};
const request = {
  capabilityRevision: "capability:one",
  requestedVersion: "materialization:one",
  catalogVersion: "catalog:one",
  appliedDomains: [{ domainId: "artifacts" }]
};

function storeWith(patch = {}) {
  return {
    getSessionToolCatalogMaterialization: () => ({
      exposurePlan: { bootstrapSchemaHash: patch.recordBootstrapSchemaHash ?? plan.bootstrapSchemaHash },
      appliedVersion: patch.recordAppliedVersion ?? patch.appliedVersion ?? request.requestedVersion,
      appliedCatalogVersion: request.catalogVersion,
      appliedDomains: request.appliedDomains,
      providerReceipt: {
        providerBindingId: binding.providerBindingId,
        providerCapabilityRevision: request.capabilityRevision,
        requestedVersion: request.requestedVersion,
        appliedVersion: request.requestedVersion,
        appliedCatalogVersion: request.catalogVersion,
        appliedExposurePlanHash: plan.exposurePlanHash,
        appliedDomains: request.appliedDomains,
        refreshMode: plan.refreshMode,
        providerRevision: `thread-start:${binding.providerSessionId}:confirmed`,
        ...patch
      }
    })
  };
}

test("a restarted Codex runtime restores an exact legacy restricted-gateway receipt", () => {
  const runtime = new CodexAppServerClient();
  const confirmation = confirmOrRestoreCodexToolPlan({
    runtime, store: storeWith(), binding, plan, request
  });
  assert.equal(confirmation.restored, true);
  assert.equal(runtime.confirmThreadToolPlan(binding.providerSessionId, definitions).restored, true);
});

test("Tool-schema confirmation survives a new authorization materialization generation", () => {
  const runtime = new CodexAppServerClient();
  const confirmation = confirmOrRestoreCodexToolPlan({
    runtime,
    store: storeWith({
      requestedVersion: "materialization:previous",
      appliedVersion: "materialization:previous",
      appliedExposurePlanHash: "exposure:previous"
    }),
    binding,
    plan,
    request
  });
  assert.equal(confirmation.restored, true);
  assert.equal(runtime.confirmThreadToolPlan(binding.providerSessionId, definitions).restored, true);
});

test("persisted confirmation recovery fails closed on binding, generation, or schema drift", () => {
  for (const patch of [
    { providerBindingId: "binding:other" },
    { recordAppliedVersion: "materialization:other" },
    { recordBootstrapSchemaHash: "bootstrap:other" },
    { providerRevision: "thread-start:thread:other:confirmed" }
  ]) {
    assert.throws(() => confirmOrRestoreCodexToolPlan({
      runtime: new CodexAppServerClient(), store: storeWith(patch), binding, plan, request
    }), { code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED" });
  }
});
