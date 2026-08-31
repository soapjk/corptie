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
    const committedProviderConfirmation = receipt
      && receipt.providerBindingId === binding.providerBindingId
      && record.appliedVersion === receipt.appliedVersion
      && record.appliedCatalogVersion === receipt.appliedCatalogVersion
      && JSON.stringify(record.appliedDomains ?? []) === JSON.stringify(receipt.appliedDomains ?? []);
    const exactDefinitionsHash = receipt?.providerDefinitionsHash === plan.providerDefinitionsHash;
    const exactDefinitionsCount = receipt?.providerDefinitionsCount === plan.providerDefinitions.length;
    const exactObservationKind = receipt?.providerObservationKind === "thread_start_accepted"
      || receipt?.providerObservationKind === "thread_fork_inherited";
    if (!committedProviderConfirmation || !exactDefinitionsHash
      || !exactDefinitionsCount || !exactObservationKind) throw error;
    return runtime.restoreThreadToolPlanConfirmation(
      binding.providerSessionId,
      plan.providerDefinitions,
      {
        providerRevision: receipt.providerRevision,
        providerDefinitionsHash: receipt.providerDefinitionsHash,
        providerDefinitionsCount: receipt.providerDefinitionsCount,
        providerObservationKind: receipt.providerObservationKind
      }
    );
  }
}
