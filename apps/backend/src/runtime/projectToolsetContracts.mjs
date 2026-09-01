import {
  canonicalJson, contractError, dependencyManifestIdentity,
  requireClosedObject,
  requireHash,
  requirePrefixedHash,
  validationCacheKey,
  validationReceiptHash
} from "./projectToolsetCanonical.mjs";

export const TOOLSET_CONTRACT = Object.freeze({
  artifactId: "artifact:f7dd23d2-1f18-4177-9fa5-87970385974a",
  version: 1,
  contentHash: "8cbbb4a96d0acec3f0d0a1dfaa7806bba6d135ddf84a1d4aa32c84e298a70147"
});
export const TOOLSET_RECEIPT_SCHEMA = Object.freeze({
  artifactId: "artifact:ed9a09d9-d2b1-4446-9a34-4ef491570ef3",
  version: 1,
  contentHash: "6d96157deeb6d675a572478247312650a8eba8bb58f54568fd3aa25af8013669"
});
export const STARTUP_CONTRACT = Object.freeze({
  artifactId: "artifact:7f26689a-5b9a-4b32-ad86-ad93c0be2949",
  version: 1,
  contentHash: "472b8c34180f2c1e7f7b59d7e2c8fc620ec515971a56e5f8ecae6fe69a0aced2"
});
export const RUN_CONTRACT = Object.freeze({
  artifactId: "artifact:42cd149b-e230-4347-b4ff-b816c18cf25f",
  version: 1,
  contentHash: "b64fab56fdce275b29a99dd63f1ecd84a95419d3e0c8a4e752ebdf91e5321951"
});
export const SNAPSHOT_SEARCH_SCHEMA = Object.freeze({
  artifactId: "artifact:ee9b734f-799d-41b6-804f-9868697de511",
  version: 1,
  contentHash: "a288feb13a2c784e1267d4c40b44e1a0204c530c8f0b9910f0d9f2f52a9ccc76"
});

export const FIXED_DEPENDENCY_MANIFEST = Object.freeze({ schemaVersion: 4, entries: Object.freeze([
  { dependency: "startup_binding_receipt", acceptanceState: "approved_fixed", artifactId: STARTUP_CONTRACT.artifactId, version: 1, contentHash: STARTUP_CONTRACT.contentHash, contractSchemaVersions: { StartupBindingReceipt: 2 } },
  { dependency: "repository_snapshot_search_schema", acceptanceState: "approved_fixed", artifactId: SNAPSHOT_SEARCH_SCHEMA.artifactId, version: 1, contentHash: SNAPSHOT_SEARCH_SCHEMA.contentHash, contractSchemaVersions: { RepositorySourceSnapshotReceiptRef: 1 } },
  { dependency: "toolset_validation_receipt_schema", acceptanceState: "approved_fixed", artifactId: TOOLSET_RECEIPT_SCHEMA.artifactId, version: 1, contentHash: TOOLSET_RECEIPT_SCHEMA.contentHash, contractSchemaVersions: { ToolsetValidationReceipt: 3 } },
  { dependency: "run_cleanup_receipt_schema", acceptanceState: "approved_fixed", artifactId: RUN_CONTRACT.artifactId, version: 1, contentHash: RUN_CONTRACT.contentHash, contractSchemaVersions: { CleanupReceipt: 4, RunReceipt: 6 } }
]) });
export const FIXED_DEPENDENCY_MANIFEST_IDENTITY = dependencyManifestIdentity(FIXED_DEPENDENCY_MANIFEST);

export const ACTION_KINDS = Object.freeze(["build", "test", "lint", "typecheck", "service_validation"]);
export const OUTCOMES = Object.freeze(["passed", "failed", "unsupported", "needs_configuration", "cancelled", "unknown", "stale", "mismatch"]);
export const CAPABILITY_CLASSES = Object.freeze(["none", "run_isolation_only", "restricted_project_toolset_generation", "full_required"]);

const SNAPSHOT_FIELDS = ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion", "artifactRef"];
const STARTUP_RECEIPT_REF_FIELDS = ["startupOperationId", "receiptHash", "schemaVersion", "resourceVersion", "artifactRef"];
const TOOLSET_POINTER_FIELDS = ["receiptId", "receiptHash", "resourceVersion", "toolsetVersion", "validationPlanIdentity", "sourceFingerprint"];
const RESOLVED_RECEIPT_REF_FIELDS = ["receiptId", "receiptHash", "schemaVersion", "issuer", "resourceVersion", "artifactRef"];
const CONTRACT_REF_FIELDS = ["artifactId", "version", "contentHash", "relation", "receiptType", "schemaVersion"];
const RUN_REF_FIELDS = ["receiptId", "receiptHash", "schemaVersion", "resourceVersion", "artifactRef", "runId"];
const ERROR_FIELDS = ["code", "message", "retryable", "details"];
const ERROR_DETAILS_FIELDS = ["actionId", "assertionId", "phase"];
const RECEIPT_FIELDS = ["receiptId", "receiptHash", "schemaVersion", "resourceVersion", "artifactRef", "identity", "snapshotRef", "toolsetVersion", "validationPlanIdentity", "validationCacheKey", "actionReceipts", "assertionReceipts", "cacheDisposition", "outcome", "startedAt", "finishedAt", "expiresAt", "error"];
const IDENTITY_FIELDS = ["logicalSessionId", "objectiveId", "taskId", "repositoryId", "worktreeId", "startupBindingRef"];
const STARTUP_REF_FIELDS = ["artifactId", "artifactVersion", "artifactContentHash", "startupOperationId", "startupReceiptHash"];
const ARTIFACT_REF_FIELDS = ["artifactId", "version", "contentHash", "relation", "receiptType", "schemaVersion"];
const ACTION_FIELDS = ["id", "kind", "ordinal", "executionDisposition", "outcome", "runReceiptRef", "cleanupReceiptRef", "startedAt", "finishedAt", "evidenceHash", "error"];
const ASSERTION_FIELDS = ["id", "actionId", "assertionType", "outcome", "startedAt", "finishedAt", "evidenceHash", "error"];
const RUN_RECEIPT_FIELDS = ["schemaVersion", "receiptId", "receiptHash", "runId", "mode", "logicalSessionId", "taskId", "repositoryId", "worktreeId", "sourceFingerprint", "startupBindingReceiptRef", "repositorySourceSnapshotReceiptRef", "toolsetValidationReceiptPointer", "state", "outcome", "runContextHash", "dataRootBindingId", "processLeaseRefs", "portLeaseRefs", "dataLeaseRef", "credentialLeaseRefs", "fencingToken", "resourceVersion", "eventRefs", "metricsRef", "readyAt", "startedAt", "stoppedAt", "completedAt", "error"];
const CLEANUP_RECEIPT_FIELDS = ["schemaVersion", "receiptId", "receiptHash", "cleanupOperationId", "runId", "runReceiptRef", "logicalSessionId", "taskId", "repositoryId", "worktreeId", "sourceFingerprint", "outcome", "policy", "ownerSessionId", "retentionReason", "retentionPolicyVersion", "retainUntil", "quotaBytes", "observedBytes", "fencingToken", "resourceVersion", "dataRootBindingId", "sourceIdentityHash", "trashIdentityHash", "safetyChecks", "processReconciliation", "bytesReclaimed", "filesRemoved", "eventRefs", "startedAt", "finishedAt", "error"];
const CLEANUP_SAFETY_CHECKS = ["canonicalRoot", "runMarker", "identity", "leaseOwner", "fence", "noSymlink", "noHardlinkEscape", "noMountCrossing", "noActiveProcess", "noActivePort", "noActiveDataLease", "noActiveCredentialLease", "serverHandleClosed", "targetBoundary"];

export function validateDependencyManifest(manifest) {
  if (dependencyManifestIdentity(manifest) !== FIXED_DEPENDENCY_MANIFEST_IDENTITY) fail("TOOLSET_DEPENDENCY_CONTRACT_MISMATCH");
  return true;
}

export function validateStartupBindingRef(value) {
  requireClosedObject(value, STARTUP_REF_FIELDS, "StartupBindingRef");
  if (value.artifactId !== STARTUP_CONTRACT.artifactId || value.artifactVersion !== 1
    || value.artifactContentHash !== STARTUP_CONTRACT.contentHash) fail("STARTUP_BINDING_INVALID");
  boundedString(value.startupOperationId, 512, "startupOperationId");
  requireHash(value.startupReceiptHash, "startupReceiptHash");
  return value;
}

export function validateStartupBindingReceipt(receipt, expected, ref) {
  if (!plain(receipt) || receipt.schemaVersion !== 2 || receipt.status !== "ready"
    || receipt.startupOperationId !== ref.startupOperationId || receipt.receiptHash !== ref.startupReceiptHash
    || receipt.logicalSessionId !== expected.logicalSessionId || receipt.objectiveId !== expected.objectiveId
    || receipt.taskId !== expected.taskId || receipt.repositoryId !== expected.repositoryId
    || receipt.worktreeId !== expected.worktreeId) fail("STARTUP_BINDING_INVALID");
  if (Object.hasOwn(receipt, "receiptId") || Object.hasOwn(receipt, "artifactRef")) fail("STARTUP_BINDING_INVALID");
  return receipt;
}

export function validateSnapshotRef(value) {
  requireClosedObject(value, SNAPSHOT_FIELDS, "RepositorySourceSnapshotReceiptRef");
  boundedString(value.receiptId, 128, "receiptId");
  requireHash(value.receiptHash, "receiptHash");
  requireHash(value.sourceFingerprint, "sourceFingerprint");
  if (value.schemaVersion !== 1 || !Number.isInteger(value.resourceVersion) || value.resourceVersion < 1) fail("RECEIPT_INVALID");
  validateContractArtifactRef(value.artifactRef, "RepositorySourceSnapshotReceipt", 1, null);
  return value;
}

export function validateStartupBindingReceiptRef(value) {
  requireClosedObject(value, STARTUP_RECEIPT_REF_FIELDS, "StartupBindingReceiptRef");
  boundedString(value.startupOperationId, 512, "startupOperationId"); requireHash(value.receiptHash, "receiptHash");
  if (value.schemaVersion !== 2 || !Number.isInteger(value.resourceVersion) || value.resourceVersion < 1) fail("STARTUP_BINDING_INVALID");
  validateContractArtifactRef(value.artifactRef, "StartupBindingReceipt", 2, STARTUP_CONTRACT);
  return value;
}

export function validateRunReceiptRef(value, type) {
  requireClosedObject(value, RUN_REF_FIELDS, `${type}ReceiptRef`);
  boundedString(value.receiptId, 128, "receiptId");
  requireHash(value.receiptHash, "receiptHash");
  boundedString(value.runId, 128, "runId");
  const schemaVersion = type === "Run" ? 6 : 4;
  if (value.schemaVersion !== schemaVersion || !Number.isInteger(value.resourceVersion) || value.resourceVersion < 1) fail("RECEIPT_INVALID");
  validateContractArtifactRef(value.artifactRef, `${type}Receipt`, schemaVersion, RUN_CONTRACT);
  return value;
}

export function validateRunReceipt(receipt, context, options = {}) {
  requireClosedObject(receipt, RUN_RECEIPT_FIELDS, "RunReceipt v6");
  if (receipt.schemaVersion !== 6 || receipt.mode !== "test") fail("RECEIPT_INVALID");
  validateResolvedReceipt(receipt, context, "RunReceipt");
  validateStartupBindingReceiptRef(receipt.startupBindingReceiptRef);
  validateSnapshotRef(receipt.repositorySourceSnapshotReceiptRef);
  if (context.startupBindingReceiptRef && canonicalJson(receipt.startupBindingReceiptRef) !== canonicalJson(context.startupBindingReceiptRef)) fail("STARTUP_BINDING_INVALID");
  if (receipt.toolsetValidationReceiptPointer !== null) validateToolsetPointerShape(receipt.toolsetValidationReceiptPointer, context);
  if (!Array.isArray(receipt.processLeaseRefs) || !Array.isArray(receipt.portLeaseRefs)
    || !Array.isArray(receipt.credentialLeaseRefs) || !Array.isArray(receipt.eventRefs)) fail("RECEIPT_INVALID");
  if (!Number.isInteger(receipt.fencingToken) || receipt.fencingToken < 1
    || !Number.isInteger(receipt.resourceVersion) || receipt.resourceVersion < 1) fail("RECEIPT_INVALID");
  if (receipt.repositorySourceSnapshotReceiptRef?.receiptHash !== context.snapshotRef.receiptHash
    || receipt.repositorySourceSnapshotReceiptRef?.sourceFingerprint !== context.snapshotRef.sourceFingerprint) fail("SNAPSHOT_STALE");
  if (receipt.outcome === "unknown" || receipt.outcome === null) fail("OUTCOME_UNKNOWN");
  if (!new Set(["completed", "failed", "cancelled"]).has(receipt.state)) fail("OUTCOME_UNKNOWN");
  if (receipt.outcome === "passed" && receipt.state !== "completed") fail("RECEIPT_INVALID");
  if (options.requirePassed !== false && receipt.outcome !== "passed") fail("RUN_FAILED");
  return receipt;
}

export function validateCleanupReceipt(receipt, context, runReceipt) {
  requireClosedObject(receipt, CLEANUP_RECEIPT_FIELDS, "CleanupReceipt v4");
  if (receipt.schemaVersion !== 4) fail("RECEIPT_INVALID");
  validateResolvedReceipt(receipt, context, "CleanupReceipt");
  validateResolvedRunReceiptRef(receipt.runReceiptRef);
  if (receipt.runId !== runReceipt.runId || receipt.runReceiptRef?.receiptId !== runReceipt.receiptId
    || receipt.runReceiptRef?.receiptHash !== runReceipt.receiptHash || receipt.runReceiptRef?.resourceVersion !== runReceipt.resourceVersion) fail("RECEIPT_INVALID");
  if (receipt.outcome !== "cleaned") fail("CLEANUP_UNKNOWN");
  if (!plain(receipt.safetyChecks) || canonicalJson(Object.keys(receipt.safetyChecks).sort()) !== canonicalJson([...CLEANUP_SAFETY_CHECKS].sort())
    || Object.values(receipt.safetyChecks).some((check) => check?.status !== "passed")) fail("CLEANUP_UNKNOWN");
  return receipt;
}

function validateResolvedRunReceiptRef(value) {
  requireClosedObject(value, RESOLVED_RECEIPT_REF_FIELDS, "CleanupReceipt.runReceiptRef");
  boundedString(value.receiptId, 512, "receiptId"); requireHash(value.receiptHash, "receiptHash");
  if (value.schemaVersion !== 6 || value.issuer !== "run_isolation" || !Number.isInteger(value.resourceVersion) || value.resourceVersion < 1) fail("RECEIPT_INVALID");
  validateContractArtifactRef(value.artifactRef, "RunReceipt", 6, RUN_CONTRACT);
}

export function resolvedRunReceiptRef(receipt, type) {
  const schemaVersion = type === "Run" ? 6 : 4;
  return validateRunReceiptRef({
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    schemaVersion,
    resourceVersion: receipt.resourceVersion,
    artifactRef: {
      artifactId: RUN_CONTRACT.artifactId,
      version: RUN_CONTRACT.version,
      contentHash: RUN_CONTRACT.contentHash,
      relation: "implementation_spec",
      receiptType: `${type}Receipt`,
      schemaVersion
    },
    runId: receipt.runId
  }, type);
}

export function toolsetValidationReceiptPointer(receipt, expectedIdentity = null) {
  validateToolsetReceiptShape(receipt);
  if (validationReceiptHash(receipt) !== receipt.receiptHash || receipt.outcome !== "passed") fail("RECEIPT_INVALID");
  if (expectedIdentity) for (const key of ["logicalSessionId", "taskId", "repositoryId", "worktreeId"]) if (receipt.identity[key] !== expectedIdentity[key]) fail("RECEIPT_INVALID");
  return Object.freeze({ receiptId: receipt.receiptId, receiptHash: receipt.receiptHash, resourceVersion: receipt.resourceVersion, toolsetVersion: receipt.toolsetVersion, validationPlanIdentity: receipt.validationPlanIdentity, sourceFingerprint: receipt.snapshotRef.sourceFingerprint });
}

export function validateToolsetReceiptShape(receipt) {
  requireClosedObject(receipt, RECEIPT_FIELDS, "ToolsetValidationReceipt");
  if (!/^toolset_validation_receipt:[A-Za-z0-9_-]+$/.test(receipt.receiptId) || receipt.schemaVersion !== 3
    || !Number.isInteger(receipt.resourceVersion) || receipt.resourceVersion < 1) fail("RECEIPT_INVALID");
  requireHash(receipt.receiptHash, "receiptHash");
  validateContractArtifactRef(receipt.artifactRef, "ToolsetValidationReceipt", 3, TOOLSET_RECEIPT_SCHEMA);
  requireClosedObject(receipt.identity, IDENTITY_FIELDS, "identity");
  for (const name of ["logicalSessionId", "objectiveId", "taskId", "repositoryId", "worktreeId"]) boundedString(receipt.identity[name], 512, name);
  validateStartupBindingRef(receipt.identity.startupBindingRef);
  validateSnapshotRef(receipt.snapshotRef);
  requirePrefixedHash(receipt.toolsetVersion, "ptv1", "toolsetVersion");
  requirePrefixedHash(receipt.validationPlanIdentity, "vp1", "validationPlanIdentity");
  requirePrefixedHash(receipt.validationCacheKey, "tvck1", "validationCacheKey");
  if (!Array.isArray(receipt.actionReceipts) || receipt.actionReceipts.length > 64) fail("RECEIPT_INVALID");
  if (!Array.isArray(receipt.assertionReceipts) || receipt.assertionReceipts.length > 256) fail("RECEIPT_INVALID");
  receipt.actionReceipts.forEach(validateActionReceipt);
  receipt.assertionReceipts.forEach(validateAssertionReceipt);
  enumValue(receipt.cacheDisposition, ["stored", "reused", "bypassed", "miss", "rejected", "invalidated"], "cacheDisposition");
  enumValue(receipt.outcome, OUTCOMES, "outcome");
  dateTime(receipt.startedAt, "startedAt"); dateTime(receipt.finishedAt, "finishedAt");
  if (receipt.expiresAt !== null) dateTime(receipt.expiresAt, "expiresAt");
  validateBusinessError(receipt.error, receipt.outcome !== "passed");
  if (receipt.outcome === "passed" && receipt.error !== null) fail("RECEIPT_INVALID");
  return receipt;
}

export async function validateToolsetReceipt(receipt, context, ports) {
  validateToolsetReceiptShape(receipt);
  if (validationReceiptHash(receipt) !== receipt.receiptHash) fail("RECEIPT_INVALID");
  for (const key of ["logicalSessionId", "objectiveId", "taskId", "repositoryId", "worktreeId"]) {
    if (receipt.identity[key] !== context[key]) fail("SOURCE_FINGERPRINT_MISMATCH");
  }
  if (receipt.snapshotRef.receiptHash !== context.snapshotRef.receiptHash
    || receipt.snapshotRef.sourceFingerprint !== context.snapshotRef.sourceFingerprint) fail("SNAPSHOT_STALE");
  const expectedCacheKey = validationCacheKey({
    schemaVersion: 1,
    repositoryId: context.repositoryId,
    worktreeId: context.worktreeId,
    snapshotReceiptHash: context.snapshotRef.receiptHash,
    sourceFingerprint: context.snapshotRef.sourceFingerprint,
    toolsetVersion: receipt.toolsetVersion,
    validationPlanIdentity: receipt.validationPlanIdentity,
    validationPolicyVersion: context.validationPolicyVersion
  });
  if (receipt.validationCacheKey !== expectedCacheKey) fail("SOURCE_FINGERPRINT_MISMATCH");
  if (context.toolsetVersion && receipt.toolsetVersion !== context.toolsetVersion) fail("RECEIPT_INVALID");
  if (context.validationPlanIdentity && receipt.validationPlanIdentity !== context.validationPlanIdentity) fail("RECEIPT_INVALID");
  const startup = await ports.startupBindingReceiptReader.get(receipt.identity.startupBindingRef);
  validateStartupBindingReceipt(startup, context, receipt.identity.startupBindingRef);
  const snapshot = await ports.repositorySourceSnapshotPort.get(receipt.snapshotRef);
  if (!plain(snapshot) || snapshot.receiptHash !== receipt.snapshotRef.receiptHash
    || snapshot.sourceFingerprint !== receipt.snapshotRef.sourceFingerprint || snapshot.stale === true) fail("SNAPSHOT_STALE");
  const actionIds = new Set();
  for (let index = 0; index < receipt.actionReceipts.length; index += 1) {
    const action = receipt.actionReceipts[index];
    if (action.ordinal !== index || actionIds.has(action.id)) fail("RECEIPT_INVALID");
    actionIds.add(action.id);
    if (action.executionDisposition === "executed") {
      if (action.runReceiptRef.runId !== action.cleanupReceiptRef.runId) fail("RECEIPT_INVALID");
      const run = validateRunReceipt(await ports.runIsolationPort.getRunReceipt(action.runReceiptRef), context);
      const cleanup = validateCleanupReceipt(await ports.runIsolationPort.getCleanupReceipt(action.cleanupReceiptRef), context, run);
      if (run.receiptHash !== action.runReceiptRef.receiptHash || run.runId !== action.runReceiptRef.runId) fail("RUN_FAILED");
      if (cleanup.receiptHash !== action.cleanupReceiptRef.receiptHash || cleanup.runId !== action.cleanupReceiptRef.runId) fail("CLEANUP_UNKNOWN");
    }
  }
  for (const assertion of receipt.assertionReceipts) if (!actionIds.has(assertion.actionId)) fail("RECEIPT_INVALID");
  if (receipt.outcome === "passed") {
    if (receipt.actionReceipts.some((item) => item.outcome !== "passed") || receipt.assertionReceipts.some((item) => item.outcome !== "passed")) fail("OUTCOME_UNKNOWN");
  } else if (["unknown", "stale", "mismatch"].includes(receipt.outcome)) fail("OUTCOME_UNKNOWN");
  return receipt;
}

function validateActionReceipt(value) {
  requireClosedObject(value, ACTION_FIELDS, "ActionReceipt");
  boundedString(value.id, 128, "id"); enumValue(value.kind, ACTION_KINDS, "kind");
  if (!Number.isInteger(value.ordinal) || value.ordinal < 0) fail("RECEIPT_INVALID");
  enumValue(value.executionDisposition, ["not_started", "executed"], "executionDisposition"); enumValue(value.outcome, OUTCOMES, "outcome");
  if (value.executionDisposition === "not_started") {
    if (value.runReceiptRef !== null || value.cleanupReceiptRef !== null || value.outcome === "passed") fail("RECEIPT_INVALID");
  } else {
    validateRunReceiptRef(value.runReceiptRef, "Run"); validateRunReceiptRef(value.cleanupReceiptRef, "Cleanup");
  }
  dateTime(value.startedAt, "startedAt"); dateTime(value.finishedAt, "finishedAt");
  if (value.evidenceHash !== null) requireHash(value.evidenceHash, "evidenceHash");
  validateBusinessError(value.error, value.outcome !== "passed");
}

function validateAssertionReceipt(value) {
  requireClosedObject(value, ASSERTION_FIELDS, "AssertionReceipt"); boundedString(value.id, 128, "id"); boundedString(value.actionId, 128, "actionId");
  enumValue(value.assertionType, ["exit_code", "output_schema", "artifact_exists", "service_health", "diagnostic_absence", "custom_declarative"], "assertionType");
  enumValue(value.outcome, OUTCOMES, "outcome"); dateTime(value.startedAt, "startedAt"); dateTime(value.finishedAt, "finishedAt");
  if (value.evidenceHash !== null) requireHash(value.evidenceHash, "evidenceHash"); validateBusinessError(value.error, value.outcome !== "passed");
}

function validateBusinessError(value, required) {
  if (value === null && !required) return;
  if (value === null || !required) fail("RECEIPT_INVALID");
  requireClosedObject(value, ERROR_FIELDS, "BusinessError");
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(value.code) || typeof value.message !== "string" || value.message.length < 1 || value.message.length > 512 || typeof value.retryable !== "boolean") fail("RECEIPT_INVALID");
  if (/\/(?:Users|Volumes|private|tmp)\/|(?:token|secret|password)=|-----BEGIN/i.test(value.message)) fail("RECEIPT_INVALID");
  if (value.details !== null) { requireClosedObject(value.details, ERROR_DETAILS_FIELDS, "BusinessError.details"); enumValue(value.details.phase, ["detect", "plan", "generate", "update", "validate", "cache", null], "phase"); }
}

function validateArtifactRef(value) { requireClosedObject(value, ARTIFACT_REF_FIELDS, "artifactRef"); if (!/^artifact:[0-9a-f-]+$/.test(value.artifactId) || !Number.isInteger(value.version) || value.version < 1 || value.relation !== "implementation_spec" || typeof value.receiptType !== "string" || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) fail("RECEIPT_INVALID"); requireHash(value.contentHash, "contentHash"); }
function validateToolsetPointerShape(value, context) {
  requireClosedObject(value, TOOLSET_POINTER_FIELDS, "ToolsetValidationReceiptPointer");
  if (!/^toolset_validation_receipt:[A-Za-z0-9_-]+$/.test(value.receiptId) || !Number.isInteger(value.resourceVersion) || value.resourceVersion < 1) fail("RECEIPT_INVALID");
  requireHash(value.receiptHash, "receiptHash"); requirePrefixedHash(value.toolsetVersion, "ptv1", "toolsetVersion"); requirePrefixedHash(value.validationPlanIdentity, "vp1", "validationPlanIdentity"); requireHash(value.sourceFingerprint, "sourceFingerprint");
  if (value.sourceFingerprint !== context.snapshotRef.sourceFingerprint) fail("SOURCE_FINGERPRINT_MISMATCH");
}
function validateResolvedReceipt(receipt, context, type) {
  boundedString(receipt.receiptId, 128, "receiptId"); boundedString(receipt.runId, 128, "runId"); requireHash(receipt.receiptHash, "receiptHash"); requireHash(receipt.sourceFingerprint, "sourceFingerprint");
  if (validationReceiptHash(receipt) !== receipt.receiptHash) fail("RECEIPT_INVALID");
  for (const key of ["logicalSessionId", "taskId", "repositoryId", "worktreeId"]) if (receipt[key] !== context[key]) fail("RECEIPT_INVALID");
  if (receipt.sourceFingerprint !== context.snapshotRef.sourceFingerprint) fail("SOURCE_FINGERPRINT_MISMATCH");
  if (type === "CleanupReceipt" && receipt.ownerSessionId !== context.logicalSessionId) fail("RECEIPT_INVALID");
}
function validateContractArtifactRef(value, type, schemaVersion, exact) { requireClosedObject(value, CONTRACT_REF_FIELDS, "contract artifactRef"); if (value.relation !== "implementation_spec" || value.receiptType !== type || value.schemaVersion !== schemaVersion) fail("RECEIPT_INVALID"); if (exact && (value.artifactId !== exact.artifactId || value.version !== exact.version || value.contentHash !== exact.contentHash)) fail("RECEIPT_INVALID"); validateArtifactRef(value); }
function boundedString(value, max, name) { if (typeof value !== "string" || !value || value.length > max) throw contractError("RECEIPT_INVALID", `${name} is invalid.`); }
function enumValue(value, values, name) { if (!values.includes(value)) throw contractError("RECEIPT_INVALID", `${name} is unknown.`); }
function dateTime(value, name) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw contractError("RECEIPT_INVALID", `${name} is invalid.`); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(code) { throw contractError(code, "Project Toolset contract validation failed."); }
