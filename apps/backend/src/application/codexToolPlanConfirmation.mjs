import {
  providerContractHashFromReceipt,
  toolDefinitionsContractHash
} from "./hostToolCatalog.mjs";

export function codexAppliedToolProofIsCurrent(binding, record, capabilityRevision) {
  if (binding?.providerId !== "codex-app-server") return true;
  const receipt = record?.providerReceipt ?? {};
  const definitions = record?.exposurePlan?.providerDefinitions;
  const threadId = binding.providerSessionId;
  const startProof = typeof receipt.providerRevision === "string"
    && receipt.providerRevision.startsWith(`thread-start:${threadId}:`)
    && receipt.providerObservationKind === "thread_start_accepted";
  const inheritedProof = typeof receipt.providerRevision === "string"
    && receipt.providerRevision.startsWith(`thread-fork-inherited:${threadId}:`)
    && receipt.providerObservationKind === "thread_fork_inherited";
  const expectedContractHash = record?.exposurePlan?.providerContractHash
    ?? (Array.isArray(definitions) ? toolDefinitionsContractHash(definitions) : null);
  return record?.exposurePlan?.capabilityRevision === capabilityRevision
    && receipt.providerCapabilityRevision === capabilityRevision
    && typeof receipt.providerDefinitionsHash === "string"
    && providerContractHashFromReceipt(receipt, definitions) === expectedContractHash
    && Array.isArray(definitions)
    && receipt.providerDefinitionsCount === definitions.length
    && (startProof || inheritedProof);
}

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
    const requestedContractHash = plan.providerContractHash
      ?? toolDefinitionsContractHash(plan.providerDefinitions);
    const compatibleContractHash = providerContractHashFromReceipt(
      receipt,
      record?.exposurePlan?.providerDefinitions ?? plan.providerDefinitions
    ) === requestedContractHash;
    const exactDefinitionsCount = receipt?.providerDefinitionsCount === plan.providerDefinitions.length;
    const exactObservationKind = receipt?.providerObservationKind === "thread_start_accepted"
      || receipt?.providerObservationKind === "thread_fork_inherited";
    if (!committedProviderConfirmation || !compatibleContractHash
      || !exactDefinitionsCount || !exactObservationKind) throw error;
    return runtime.restoreThreadToolPlanConfirmation(
      binding.providerSessionId,
      plan.providerDefinitions,
      {
        providerRevision: receipt.providerRevision,
        providerDefinitionsHash: receipt.providerDefinitionsHash,
        providerContractHash: providerContractHashFromReceipt(
          receipt,
          record?.exposurePlan?.providerDefinitions ?? plan.providerDefinitions
        ),
        providerDefinitionsCount: receipt.providerDefinitionsCount,
        providerObservationKind: receipt.providerObservationKind
      }
    );
  }
}
