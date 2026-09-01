import {
  contractError,
  receiptHash,
  validateRepositorySourceSnapshotReceipt,
  validateToolsetValidationReceipt
} from "./receiptContracts.mjs";

const fixed = (value) => Object.freeze({ status: "resolved", approvalStatus: "approved", versionPolicy: "fixed", ...value });

export const DEPENDENCY_CONTRACT_MANIFEST = Object.freeze({
  startupBinding: fixed({ owner: "worktree_startup", receiptType: "StartupBindingReceipt", schemaVersion: 2, artifactId: "artifact:7f26689a-5b9a-4b32-ad86-ad93c0be2949", version: 1, contentHash: "472b8c34180f2c1e7f7b59d7e2c8fc620ec515971a56e5f8ecae6fe69a0aced2" }),
  repositorySourceSnapshot: fixed({ owner: "repository_source_snapshot", receiptType: "RepositorySourceSnapshotReceipt", schemaVersion: 1, artifactId: "artifact:ee9b734f-799d-41b6-804f-9868697de511", version: 1, contentHash: "a288feb13a2c784e1267d4c40b44e1a0204c530c8f0b9910f0d9f2f52a9ccc76" }),
  toolsetValidation: fixed({ owner: "project_toolset", receiptType: "ToolsetValidationReceipt", schemaVersion: 3, artifactId: "artifact:ed9a09d9-d2b1-4446-9a34-4ef491570ef3", version: 1, contentHash: "6d96157deeb6d675a572478247312650a8eba8bb58f54568fd3aa25af8013669" }),
  runCleanup: fixed({ owner: "run_isolation", receiptTypes: Object.freeze({ RunReceipt: 6, CleanupReceipt: 4 }), artifactId: "artifact:42cd149b-e230-4347-b4ff-b816c18cf25f", version: 1, contentHash: "b64fab56fdce275b29a99dd63f1ecd84a95419d3e0c8a4e752ebdf91e5321951" })
});

export function validateDependencyManifest(manifest = DEPENDENCY_CONTRACT_MANIFEST) {
  if (Object.keys(manifest).length !== 4) throw contractError("DEPENDENCY_CONTRACT_HASH_MISMATCH", "DependencyContractManifest must contain exactly four approved authorities.");
  for (const [name, expected] of Object.entries(DEPENDENCY_CONTRACT_MANIFEST)) {
    const actual = manifest[name];
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw contractError("DEPENDENCY_CONTRACT_HASH_MISMATCH", `${name} differs from the approved fixed DependencyContractManifest.`);
    }
  }
  return true;
}

export function validateDependencyGate({ sourceAware, toolsetRequired, startupBindingReceiptRef, repositorySourceSnapshotReceiptRef, toolsetValidationReceiptPointer, manifest = DEPENDENCY_CONTRACT_MANIFEST }) {
  validateDependencyManifest(manifest);
  assertFixedReceiptRef(startupBindingReceiptRef?.artifactRef, manifest.startupBinding, "STARTUP_BINDING_IDENTITY_MISMATCH");
  if (startupBindingReceiptRef?.schemaVersion !== 2) throw contractError("STARTUP_BINDING_NOT_READY", "StartupBindingReceipt schemaVersion 2 is required.");
  if (sourceAware) {
    assertFixedReceiptRef(repositorySourceSnapshotReceiptRef?.artifactRef, manifest.repositorySourceSnapshot, "SOURCE_SNAPSHOT_IDENTITY_MISMATCH");
    if (!/^[0-9a-f]{64}$/.test(repositorySourceSnapshotReceiptRef?.sourceFingerprint ?? "")) throw contractError("SOURCE_FINGERPRINT_MISMATCH", "Snapshot sourceFingerprint is required.");
  } else if (repositorySourceSnapshotReceiptRef != null) {
    throw contractError("SOURCE_SNAPSHOT_IDENTITY_MISMATCH", "Non-repository Run must not provide a Snapshot receipt.");
  }
  if (toolsetRequired || toolsetValidationReceiptPointer != null) validateToolsetValidationReceiptPointer(toolsetValidationReceiptPointer, repositorySourceSnapshotReceiptRef?.sourceFingerprint);
  return true;
}

export function projectToolsetValidationReceiptPointer(receipt, sourceFingerprint, authority = {}, manifest = DEPENDENCY_CONTRACT_MANIFEST, now = new Date()) {
  try { validateToolsetValidationReceipt(receipt); }
  catch (error) { throw error.code ? error : contractError("RUN_TOOLSET_SCHEMA_INVALID", error.message); }
  assertFixedReceiptRef(receipt.artifactRef, manifest.toolsetValidation, "RUN_TOOLSET_SCHEMA_INVALID");
  if (receipt.outcome !== "passed" || receipt.error !== null) throw contractError("RUN_TOOLSET_SCHEMA_INVALID", "Only a passed ToolsetValidationReceipt can authorize execution.");
  if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt) || (receipt.expiresAt !== null && Date.parse(receipt.expiresAt) <= now.getTime())) {
    throw contractError("RUN_TOOLSET_SCHEMA_INVALID", "ToolsetValidationReceipt is expired or has invalid timestamps.");
  }
  for (const field of ["logicalSessionId", "objectiveId", "taskId", "repositoryId", "worktreeId"]) {
    if (Object.hasOwn(authority, field) && authority[field] !== receipt.identity[field]) throw contractError("RUN_TOOLSET_SCHEMA_INVALID", `${field} differs from the authenticated Run identity.`);
  }
  const projected = { receiptId: receipt.receiptId, receiptHash: receipt.receiptHash, resourceVersion: receipt.resourceVersion, toolsetVersion: receipt.toolsetVersion, validationPlanIdentity: receipt.validationPlanIdentity, sourceFingerprint: receipt.snapshotRef?.sourceFingerprint };
  validateToolsetValidationReceiptPointer(projected, sourceFingerprint);
  return Object.freeze(projected);
}

export async function resolveToolsetValidationReceiptPointer({ pointer, resolver, sourceFingerprint, authority, manifest = DEPENDENCY_CONTRACT_MANIFEST, now = new Date() }) {
  validateToolsetValidationReceiptPointer(pointer, sourceFingerprint);
  if (typeof resolver !== "function") throw contractError("RUN_TOOLSET_RECEIPT_UNRESOLVED", "The authoritative Toolset receipt resolver is unavailable.");
  const receipt = await resolver(pointer.receiptId);
  if (!receipt) throw contractError("RUN_TOOLSET_RECEIPT_UNRESOLVED", "The full ToolsetValidationReceipt could not be resolved.");
  const verified = projectToolsetValidationReceiptPointer(receipt, sourceFingerprint, authority, manifest, now);
  for (const key of Object.keys(pointer)) if (pointer[key] !== verified[key]) throw contractError(key === "receiptHash" ? "RUN_TOOLSET_RECEIPT_HASH_MISMATCH" : key === "sourceFingerprint" ? "RUN_SOURCE_FINGERPRINT_MISMATCH" : "RUN_TOOLSET_SCHEMA_INVALID", `${key} differs from the resolved ToolsetValidationReceipt.`);
  return verified;
}

export function validateToolsetValidationReceiptPointer(pointer, sourceFingerprint) {
  const keys = ["receiptId", "receiptHash", "resourceVersion", "toolsetVersion", "validationPlanIdentity", "sourceFingerprint"];
  if (!pointer || Object.keys(pointer).length !== keys.length || keys.some((key) => !Object.hasOwn(pointer, key))) throw contractError("RUN_TOOLSET_SCHEMA_INVALID", "ToolsetValidationReceiptPointer must be the exact closed six-field projection.");
  if (!/^toolset_validation_receipt:[A-Za-z0-9_-]+$/.test(pointer.receiptId) || !/^[0-9a-f]{64}$/.test(pointer.receiptHash) || !Number.isInteger(pointer.resourceVersion) || pointer.resourceVersion < 1 || !/^ptv1:[0-9a-f]{64}$/.test(pointer.toolsetVersion) || !/^vp1:[0-9a-f]{64}$/.test(pointer.validationPlanIdentity)) throw contractError("RUN_TOOLSET_SCHEMA_INVALID", "ToolsetValidationReceiptPointer fields are invalid.");
  if (pointer.sourceFingerprint !== sourceFingerprint) throw contractError("RUN_SOURCE_FINGERPRINT_MISMATCH", "Toolset pointer sourceFingerprint differs from the verified Snapshot fingerprint.");
  return true;
}

export function verifyRepositorySourceSnapshotReceipt(receipt, reference, authority, manifest = DEPENDENCY_CONTRACT_MANIFEST) {
  validateRepositorySourceSnapshotReceipt(receipt);
  assertFixedReceiptRef(receipt.artifactRef, manifest.repositorySourceSnapshot, "SOURCE_SNAPSHOT_SCHEMA_INVALID");
  for (const field of ["receiptId", "receiptHash", "schemaVersion", "resourceVersion", "sourceFingerprint"]) if (reference[field] !== receipt[field]) throw contractError("SOURCE_SNAPSHOT_HASH_MISMATCH", `${field} differs from the resolved RepositorySourceSnapshotReceipt.`);
  for (const field of ["objectiveId", "taskId", "logicalSessionId", "repositoryId", "worktreeId"]) if (Object.hasOwn(authority, field) && authority[field] !== receipt[field]) throw contractError("SOURCE_SNAPSHOT_IDENTITY_MISMATCH", `${field} differs from the authenticated Run identity.`);
  return receipt;
}

export function validateStartupBindingReceipt(receipt, reference, authority) {
  const required = ["startupOperationId","objectiveId","taskId","logicalSessionId","repositoryId","worktreeId","canonicalWorktreePath","headIdentity","providerBindingId","bindingGeneration","sourceCommitOid","sourceTreeOid","baseRef","repositoryInventoryVersion","workspaceResourceVersion","resourceVersion","providerContextHash","phaseTimestamps","compensation","error","receiptHash","schemaVersion","status"];
  if (!receipt || Object.keys(receipt).some((key) => !required.includes(key)) || required.some((key) => !Object.hasOwn(receipt, key))) throw contractError("STARTUP_BINDING_IDENTITY_MISMATCH", "StartupBindingReceipt field set differs from the fixed contract projection.");
  if (receipt.schemaVersion !== 2 || receipt.status !== "ready" || receipt.error !== null) throw contractError("STARTUP_BINDING_NOT_READY", "StartupBindingReceipt must be schemaVersion 2 ready.");
  if (receipt.startupOperationId !== reference.startupOperationId || receipt.receiptHash !== reference.receiptHash || receipt.resourceVersion !== reference.resourceVersion || receiptHash(receipt) !== receipt.receiptHash) throw contractError("DEPENDENCY_CONTRACT_HASH_MISMATCH", "StartupBindingReceipt reference or canonical hash mismatches.");
  for (const field of ["objectiveId","taskId","logicalSessionId","repositoryId","worktreeId","providerBindingId","bindingGeneration","sourceCommitOid","sourceTreeOid","repositoryInventoryVersion","workspaceResourceVersion","resourceVersion"]) if (Object.hasOwn(authority, field) && authority[field] !== receipt[field]) throw contractError("STARTUP_BINDING_STALE", `${field} is stale against authoritative binding.`);
  return receipt;
}

export function validateStageOwnership(stage, value) {
  const forbidden = stage === "startup" ? ["sourceFingerprint","runId","observationId"] : stage === "snapshot" ? ["runId","observationId"] : stage === "run_isolation" ? ["observationId"] : [];
  for (const field of forbidden) if (Object.hasOwn(value ?? {}, field)) throw contractError("DEPENDENCY_STAGE_OWNERSHIP_CONFLICT", `${stage} cannot own ${field}.`);
  return true;
}

function assertFixedReceiptRef(ref, contract, code) {
  if (!fixedArtifactMatches(ref, contract) || ref.schemaVersion !== contract.schemaVersion || ref.receiptType !== contract.receiptType || ref.relation !== "implementation_spec") throw contractError(code, `${contract.receiptType} does not match its fixed Artifact contract.`);
}
function fixedArtifactMatches(ref, contract) { return ref && ref.artifactId === contract.artifactId && ref.version === contract.version && ref.contentHash === contract.contentHash; }
