export function confirmOrRestoreCodexToolPlan({ runtime, store, binding, plan, request }) {
  try {
    return runtime.confirmThreadToolPlan(binding.providerSessionId, plan.providerDefinitions);
  } catch (error) {
    if (error?.code !== "PROVIDER_TOOL_APPLICATION_UNCONFIRMED") throw error;
    const record = store.getSessionToolCatalogMaterialization(
      binding.logicalSessionId,
      binding.providerBindingId
    );
    const receipt = record?.providerReceipt;
    const exactReceipt = receipt
      && receipt.providerBindingId === binding.providerBindingId
      && receipt.providerCapabilityRevision === request.capabilityRevision
      && receipt.requestedVersion === request.requestedVersion
      && receipt.appliedVersion === request.requestedVersion
      && receipt.appliedCatalogVersion === request.catalogVersion
      && receipt.appliedExposurePlanHash === plan.exposurePlanHash
      && receipt.refreshMode === plan.refreshMode
      && JSON.stringify(receipt.appliedDomains ?? []) === JSON.stringify(request.appliedDomains ?? [])
      && record.appliedVersion === receipt.appliedVersion
      && record.appliedCatalogVersion === receipt.appliedCatalogVersion
      && JSON.stringify(record.appliedDomains ?? []) === JSON.stringify(receipt.appliedDomains ?? []);
    const exactDefinitionsHash = receipt?.providerDefinitionsHash === plan.providerDefinitionsHash;
    const legacyRestrictedGateway = receipt?.providerDefinitionsHash == null
      && receipt?.refreshMode === "restricted_gateway"
      && plan.refreshMode === "restricted_gateway"
      && record?.exposurePlan?.bootstrapSchemaHash === plan.bootstrapSchemaHash;
    if (!exactReceipt || (!exactDefinitionsHash && !legacyRestrictedGateway)) throw error;
    return runtime.restoreThreadToolPlanConfirmation(
      binding.providerSessionId,
      plan.providerDefinitions,
      {
        providerRevision: receipt.providerRevision,
        providerDefinitionsHash: receipt.providerDefinitionsHash,
        allowLegacyRestrictedGateway: legacyRestrictedGateway
      }
    );
  }
}
