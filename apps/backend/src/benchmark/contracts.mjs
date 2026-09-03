import { createHash } from "node:crypto";
import { asciiCompare, assertClosedObject, benchmarkError, contentHash, hashWithout, requireFields } from "./canonical.mjs";

const fixed = (stage, role, artifactId, hash, receiptSchemaVersions = {}) => ({
  stage, role, artifactId, version: 1, contentHash: hash, approvalStatus: "approved",
  relation: "implementation_spec", versionPolicy: "fixed", receiptSchemaVersions
});

export const DEPENDENCY_CONTRACT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  entries: Object.freeze([
    fixed("artifact", "main", "artifact:fde8455f-fa8e-4ac1-9a9e-fc1ab80a99cd", "91b5bc11f6a9ffcd13b2e1c030f1c3b9e57d888ad9baa06e4603abf6934da3d9"),
    fixed("observability", "main", "artifact:c0dab1de-4fb0-4a47-a089-8695b7968476", "b742332d1f8dbbf30db76655ec13b2504aa30923fb0b9a1a635ad1fcd679b43e", { Observation: 3, ObservationExport: 4 }),
    fixed("run", "main", "artifact:44d797ea-cab1-47c8-a82b-e3d7649f5089", "35d7b3764d748ca3bda44685da8ef37b7cf24bc4bec17bea63794cae41e62069", { CleanupReceipt: 4, RunReceipt: 6 }),
    fixed("run", "schema", "artifact:42cd149b-e230-4347-b4ff-b816c18cf25f", "b64fab56fdce275b29a99dd63f1ecd84a95419d3e0c8a4e752ebdf91e5321951", { CleanupReceipt: 4, RunReceipt: 6 }),
    fixed("search", "main", "artifact:9671df72-6df3-49b1-87b2-3876db741fcb", "78e8df0a419772f57d7cb20c34006d8cd6d00ea63b5216cdd075bbff4daf37be", { CleanupReceipt: 4, RepositorySourceSnapshotReceipt: 1, RunReceipt: 6, SearchReceipt: 1, StartupBindingReceipt: 2, ToolsetValidationReceipt: 3 }),
    fixed("search", "schema", "artifact:ee9b734f-799d-41b6-804f-9868697de511", "d706d828e697618d69a65b7c1fcae9fa95f41e2c70237cc60802a0e91f0c2e15", { CleanupReceipt: 4, RepositorySourceSnapshotReceipt: 1, RunReceipt: 6, SearchReceipt: 1, StartupBindingReceipt: 2, ToolsetValidationReceipt: 3 }),
    fixed("startup", "main", "artifact:7f26689a-5b9a-4b32-ad86-ad93c0be2949", "472b8c34180f2c1e7f7b59d7e2c8fc620ec515971a56e5f8ecae6fe69a0aced2", { StartupBindingReceipt: 2 }),
    fixed("tool_host", "main", "artifact:35124de1-6e91-4f08-84ee-4ddd8aa51e8d", "8fa384d00f92fca6ceddb53abc12f7ccf60f82f510fba6a55beaaeec5f00ba5e"),
    fixed("toolset", "main", "artifact:f7dd23d2-1f18-4177-9fa5-87970385974a", "8cbbb4a96d0acec3f0d0a1dfaa7806bba6d135ddf84a1d4aa32c84e298a70147", { ToolsetValidationReceipt: 3 }),
    fixed("toolset", "schema", "artifact:ed9a09d9-d2b1-4446-9a34-4ef491570ef3", "55d976162448d8519a3d7805502921ee3474fb665fd2b17d8582e3949ae98888", { ToolsetValidationReceipt: 3 })
  ].sort((a, b) => asciiCompare(a.stage, b.stage) || asciiCompare(a.role, b.role)))
});

export const DEPENDENCY_MANIFEST_IDENTITY = contentHash(DEPENDENCY_CONTRACT_MANIFEST);

const profiles = {
  ToolHostAppliedReceipt: {
    stage: "tool_host", producer: "tool-host", schemaVersion: 1,
    fields: ["providerBindingId", "providerCapabilityRevision", "requestedVersion", "appliedVersion", "appliedCatalogVersion", "appliedDomains", "appliedExposurePlanHash", "refreshMode", "providerRevision", "receiptId", "appliedAt"],
    required: ["providerBindingId", "appliedCatalogVersion", "receiptId"], forbidden: ["toolsetVersion", "sourceFingerprint", "runId", "observationId"]
  },
  ArtifactPinnedRead: {
    stage: "artifact", producer: "artifact", schemaVersion: 1,
    fields: ["artifactId", "version", "contentHash", "mimeType", "totalBytes", "encoding", "content", "range", "complete", "pendingUpdate", "readReceiptId", "deduplicated", "turnBudget"],
    required: ["artifactId", "version", "contentHash", "range", "complete", "readReceiptId"], forbidden: ["bindingGeneration", "toolsetVersion", "sourceFingerprint", "runId", "observationId"]
  },
  StartupBindingReceipt: {
    stage: "startup", producer: "startup-binding", schemaVersion: 2,
    fields: ["schemaVersion", "status", "startupOperationId", "workId", "taskId", "logicalSessionId", "repositoryId", "worktreeId", "canonicalWorktreePath", "headIdentity", "providerBindingId", "bindingGeneration", "sourceCommitOid", "sourceTreeOid", "baseRef", "repositoryInventoryVersion", "workspaceResourceVersion", "resourceVersion", "providerContextHash", "toolContractHash", "instructionSourcesHash", "phaseTimestamps", "compensation", "error", "receiptHash"],
    required: ["workId", "taskId", "logicalSessionId", "providerBindingId", "bindingGeneration", "repositoryId", "worktreeId", "startupOperationId", "receiptHash"], forbidden: ["catalogVersion", "toolsetVersion", "sourceFingerprint", "runId", "observationId"]
  },
  RepositorySourceSnapshotReceipt: {
    stage: "snapshot", producer: "repository-source-snapshot", schemaVersion: 1,
    fields: ["receiptId", "schemaVersion", "resourceVersion", "artifactRef", "startupBindingRef", "workId", "taskId", "logicalSessionId", "repositoryId", "worktreeId", "sourceCommitOid", "sourceTreeOid", "dirtyOverlayRef", "ignoreConfigRevisionRef", "scopeRootHash", "sourceFingerprint", "createdAt", "receiptHash"],
    required: ["workId", "taskId", "logicalSessionId", "repositoryId", "worktreeId", "receiptId", "sourceFingerprint", "receiptHash"], forbidden: ["catalogVersion", "toolsetVersion", "runId", "observationId", "queryHash", "indexVersion", "resultSummary"]
  },
  ToolsetValidationReceipt: {
    stage: "toolset", producer: "project-toolset", schemaVersion: 3,
    fields: ["receiptId", "receiptHash", "schemaVersion", "resourceVersion", "artifactRef", "identity", "snapshotRef", "toolsetVersion", "validationPlanIdentity", "validationCacheKey", "actionReceipts", "assertionReceipts", "cacheDisposition", "outcome", "startedAt", "finishedAt", "expiresAt", "error"],
    required: ["receiptId", "receiptHash", "schemaVersion", "resourceVersion", "identity", "snapshotRef", "toolsetVersion", "validationPlanIdentity"], forbidden: ["runId", "observationId"]
  },
  RunReceipt: {
    stage: "run", producer: "run-isolation", schemaVersion: 6,
    fields: ["schemaVersion", "receiptId", "receiptHash", "runId", "mode", "logicalSessionId", "taskId", "repositoryId", "worktreeId", "sourceFingerprint", "startupBindingReceiptRef", "repositorySourceSnapshotReceiptRef", "toolsetValidationReceiptPointer", "state", "outcome", "runContextHash", "dataRootBindingId", "processLeaseRefs", "portLeaseRefs", "dataLeaseRef", "credentialLeaseRefs", "fencingToken", "resourceVersion", "eventRefs", "metricsRef", "readyAt", "startedAt", "stoppedAt", "completedAt", "error"],
    required: ["logicalSessionId", "taskId", "runId", "receiptId", "receiptHash", "sourceFingerprint", "startupBindingReceiptRef", "repositorySourceSnapshotReceiptRef"], forbidden: ["workId", "catalogVersion", "observationId"]
  },
  CleanupReceipt: {
    stage: "cleanup", producer: "run-isolation", schemaVersion: 4,
    fields: ["schemaVersion", "receiptId", "receiptHash", "cleanupOperationId", "runId", "runReceiptRef", "logicalSessionId", "taskId", "repositoryId", "worktreeId", "sourceFingerprint", "outcome", "policy", "ownerSessionId", "retentionReason", "retentionPolicyVersion", "retainUntil", "quotaBytes", "observedBytes", "fencingToken", "resourceVersion", "dataRootBindingId", "sourceIdentityHash", "trashIdentityHash", "safetyChecks", "processReconciliation", "bytesReclaimed", "filesRemoved", "eventRefs", "startedAt", "finishedAt", "error"],
    required: ["runId", "runReceiptRef", "logicalSessionId", "taskId", "receiptId", "receiptHash", "outcome", "safetyChecks"], forbidden: ["catalogVersion", "toolsetVersion", "observationId"]
  },
  SearchReceipt: {
    stage: "search", producer: "layered-search", schemaVersion: 1,
    fields: ["receiptId", "schemaVersion", "resourceVersion", "artifactRef", "createdAt", "searchScenarioId", "startupBindingRef", "snapshotReceiptRef", "sourceFingerprint", "toolsetValidationReceiptRef", "runIsolationReceiptRef", "runId", "cleanupReceiptRef", "queryHash", "scopeHash", "indexVersion", "candidateCategories", "layers", "latency", "resultSummary", "cancellation", "timeout", "rejectedPaths", "rejectedPathOverflowCount", "evidenceRefs", "outcome", "errorCode", "receiptHash"],
    required: ["receiptId", "receiptHash", "snapshotReceiptRef", "sourceFingerprint", "toolsetValidationReceiptRef", "queryHash", "scopeHash", "indexVersion", "candidateCategories", "layers", "latency", "resultSummary", "cancellation", "timeout", "outcome"], forbidden: ["observationId", "sourceBody", "query"]
  },
  Observation: {
    stage: "observation", producer: "turn-observability", schemaVersion: 3,
    fields: ["schemaVersion", "observationId", "turnExecutionId", "runId", "operationRef", "identity", "sourceIdentity", "versions", "receiptRefs", "producer", "producerEventId", "eventType", "observedAtUnixNano", "monotonicNano", "clockDomainId", "sourceOccurredAtUnixNano", "sourceClockQuality", "producerSequence", "safeAttributes", "status", "errorCode", "idempotencyFingerprint"],
    required: ["observationId", "identity", "observedAtUnixNano", "producer", "producerEventId"], forbidden: ["businessState"]
  },
  ObservationExport: {
    stage: "observation_export", producer: "turn-observability", schemaVersion: 4,
    fields: ["schemaVersion", "analysisVersion", "identity", "sourceIdentity", "versions", "wall", "wallPartition", "inclusive", "unattributed", "contextGrowth", "completeness", "diagnostics", "samplePolicy", "sourceReceiptIds", "summaryHash"],
    required: ["analysisVersion", "identity", "versions", "wall", "inclusive", "unattributed", "completeness", "sourceReceiptIds", "summaryHash"], forbidden: ["rawSpans", "prompt", "toolOutput"]
  }
};

export const RECEIPT_IDENTITY_PROFILES = Object.freeze(profiles);

// Composition adapters use this single constructor when projecting an
// authoritative service receipt into the fixed Benchmark envelope. The
// authority payload is never extended with Benchmark-owned identity aliases.
export function createReceiptEnvelope(receiptType, payload, request = {}, options = {}) {
  const profile = profiles[receiptType];
  if (!profile) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Unknown receipt type.", "envelope");
  const receiptId = payload?.receiptId ?? payload?.readReceiptId ?? payload?.startupOperationId
    ?? payload?.observationId ?? (receiptType === "ObservationExport" ? `observation_export:${payload?.summaryHash}` : null);
  const envelope = {
    receiptId,
    receiptType,
    producerServiceId: profile.producer,
    schemaVersion: profile.schemaVersion,
    identitySubset: receiptIdentitySubset(receiptType, payload),
    identityProfileVersion: 1,
    requestHash: contentHash(request),
    contentHash: contentHash(payload),
    issuedAt: options.issuedAt ?? new Date().toISOString(),
    status: options.status ?? "issued",
    metrics: options.metrics ?? {},
    evidence: options.evidence ?? [],
    error: options.error ?? null,
    payload
  };
  return validateReceiptEnvelope(envelope, options.validation ?? {});
}

export function validateManifest(candidate) {
  assertClosedObject(candidate, ["schemaVersion", "entries"], "DependencyContractManifest");
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.entries) || candidate.entries.length !== 10) mismatch();
  if (contentHash(candidate) !== DEPENDENCY_MANIFEST_IDENTITY) mismatch();
  return { manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY, manifest: DEPENDENCY_CONTRACT_MANIFEST };
}

export async function verifyPinnedDependencies(reader, context = {}) {
  if (!reader || typeof reader.readPinned !== "function") throw benchmarkError("BENCHMARK_DEPENDENCY_CONTRACT_MISMATCH", "Pinned Artifact reader is unavailable.", "manifest");
  const evidence = [];
  for (const entry of DEPENDENCY_CONTRACT_MANIFEST.entries) {
    const result = await reader.readPinned(entry, context);
    if (!result || result.artifactId !== entry.artifactId || result.version !== 1 || result.approvalStatus !== "approved"
      || result.relation !== "implementation_spec" || result.versionPolicy !== "fixed" || result.complete !== true
      || result.contentHash !== entry.contentHash || typeof result.content !== "string" || typeof result.readReceiptId !== "string") mismatch();
    const bytes = Buffer.from(result.content, "utf8");
    if (contentHashBytes(bytes) !== entry.contentHash) throw benchmarkError("BENCHMARK_RECEIPT_HASH_INVALID", "Pinned Artifact bytes do not match the fixed content hash.", "artifact");
    evidence.push({ artifactId: entry.artifactId, version: 1, contentHash: entry.contentHash, readReceiptId: result.readReceiptId, byteLength: bytes.byteLength });
  }
  return { manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY, evidence };
}

export function validateReceiptEnvelope(envelope, options = {}) {
  assertClosedObject(envelope, ["receiptId", "receiptType", "producerServiceId", "schemaVersion", "identitySubset", "identityProfileVersion", "requestHash", "contentHash", "issuedAt", "status", "metrics", "evidence", "error", "payload"], "ReceiptEnvelope");
  requireFields(envelope, ["receiptId", "receiptType", "producerServiceId", "schemaVersion", "identitySubset", "identityProfileVersion", "requestHash", "contentHash", "issuedAt", "status", "metrics", "evidence", "error", "payload"], "envelope");
  const profile = profiles[envelope.receiptType];
  if (!profile) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Unknown receipt type.", "envelope");
  if (envelope.producerServiceId !== profile.producer) throw benchmarkError("BENCHMARK_RECEIPT_PRODUCER_FORBIDDEN", "Receipt producer is not authoritative.", profile.stage);
  if (envelope.schemaVersion !== profile.schemaVersion || envelope.identityProfileVersion !== 1) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Receipt schema/profile version mismatch.", profile.stage);
  for (const field of profile.forbidden) if (Object.hasOwn(envelope.payload, field)) throw benchmarkError("BENCHMARK_STAGE_FIELD_FORBIDDEN", `${profile.stage} receipt contains forbidden field ${field}.`, profile.stage);
  assertClosedObject(envelope.payload, profile.fields, envelope.receiptType);
  requireFields(envelope.payload, profile.required, profile.stage);
  for (const field of profile.fields) {
    if (!Object.hasOwn(envelope.payload, field)) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", `${envelope.receiptType} is missing schema field ${field}.`, profile.stage);
  }
  if (Object.hasOwn(envelope.payload, "schemaVersion") && envelope.payload.schemaVersion !== profile.schemaVersion) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Payload schemaVersion mismatch.", profile.stage);
  const authorityReceiptId = envelope.payload.receiptId ?? envelope.payload.readReceiptId ?? envelope.payload.startupOperationId ?? envelope.payload.observationId
    ?? (envelope.receiptType === "ObservationExport" ? `observation_export:${envelope.payload.summaryHash}` : null);
  if (envelope.receiptId !== authorityReceiptId) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Envelope receiptId mismatch.", profile.stage);
  if (contentHash(envelope.identitySubset) !== contentHash(receiptIdentitySubset(envelope.receiptType, envelope.payload))) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Receipt identitySubset does not match its stage profile.", profile.stage);
  if (envelope.contentHash !== contentHash(envelope.payload)) throw benchmarkError("BENCHMARK_RECEIPT_HASH_INVALID", "Receipt content hash is invalid.", profile.stage);
  if (Object.hasOwn(envelope.payload, "receiptHash") && envelope.payload.receiptHash !== hashWithout(envelope.payload, "receiptHash")) throw benchmarkError("BENCHMARK_RECEIPT_HASH_INVALID", "Authority receiptHash is invalid.", profile.stage);
  if (envelope.receiptType === "ObservationExport" && envelope.payload.summaryHash !== hashWithout(envelope.payload, "summaryHash")) throw benchmarkError("BENCHMARK_RECEIPT_HASH_INVALID", "Observation export summaryHash is invalid.", profile.stage);
  validateSemantics(envelope.receiptType, envelope.payload, options);
  return envelope;
}

export function receiptIdentitySubset(type, value) {
  switch (type) {
    case "ToolHostAppliedReceipt": return pick(value, ["providerBindingId", "appliedCatalogVersion", "receiptId"]);
    case "ArtifactPinnedRead": return pick(value, ["artifactId", "version", "contentHash", "readReceiptId"]);
    case "StartupBindingReceipt": return pick(value, ["workId", "taskId", "logicalSessionId", "providerBindingId", "bindingGeneration", "repositoryId", "worktreeId", "startupOperationId", "receiptHash"]);
    case "RepositorySourceSnapshotReceipt": return pick(value, ["workId", "taskId", "logicalSessionId", "repositoryId", "worktreeId", "receiptId", "sourceFingerprint", "receiptHash"]);
    case "ToolsetValidationReceipt": return { ...pick(value.identity, ["logicalSessionId", "workId", "taskId", "repositoryId", "worktreeId"]), snapshotReceiptId: value.snapshotRef?.receiptId, sourceFingerprint: value.snapshotRef?.sourceFingerprint, ...pick(value, ["toolsetVersion", "validationPlanIdentity", "receiptId", "receiptHash"]) };
    case "RunReceipt": return pick(value, ["logicalSessionId", "taskId", "repositoryId", "worktreeId", "runId", "receiptId", "receiptHash", "sourceFingerprint"]);
    case "CleanupReceipt": return pick(value, ["runId", "logicalSessionId", "taskId", "repositoryId", "worktreeId", "sourceFingerprint", "receiptId", "receiptHash", "outcome"]);
    case "SearchReceipt": return { ...pick(value, ["receiptId", "receiptHash", "sourceFingerprint", "runId", "queryHash", "scopeHash", "indexVersion", "outcome"]), snapshotReceiptId: value.snapshotReceiptRef?.receiptId, toolsetReceiptId: value.toolsetValidationReceiptRef?.receiptId };
    case "Observation": return { observationId: value.observationId, ...pick(value.identity, ["workId", "taskId", "logicalSessionId", "providerBindingId", "bindingGeneration", "repositoryId", "worktreeId"]), runId: value.runId };
    case "ObservationExport": return { ...pick(value.identity, ["workId", "taskId", "logicalSessionId", "providerBindingId", "bindingGeneration", "repositoryId", "worktreeId"]), ...pick(value.versions, ["catalogVersion", "toolsetVersion", "sourceFingerprint"]), summaryHash: value.summaryHash };
    default: throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Unknown receipt type.", "envelope");
  }
}

function validateSemantics(type, value, options) {
  if (type === "StartupBindingReceipt" && (value.status !== "ready" || value.error !== null)) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Startup receipt is not ready.", "startup");
  if (type === "ToolHostAppliedReceipt" && (!Array.isArray(value.appliedDomains)
    || !value.appliedDomains.some((domain) => domain === "artifacts" || domain?.domainId === "artifacts"))) {
    throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Tool Host receipt lacks Artifact domain.", "tool_host");
  }
  if (type === "ToolsetValidationReceipt" && value.expiresAt && Date.parse(value.expiresAt) <= (options.now ?? Date.now())) throw benchmarkError("BENCHMARK_RECEIPT_STALE", "Toolset receipt is stale.", "toolset");
  if (type === "ToolsetValidationReceipt") {
    closedNested(value.identity, ["logicalSessionId", "workId", "taskId", "repositoryId", "worktreeId", "startupBindingRef"], "Toolset identity");
    closedNested(value.snapshotRef, ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion", "artifactRef"], "Toolset snapshotRef");
  }
  if (type === "RunReceipt" && value.toolsetValidationReceiptPointer != null) closedNested(value.toolsetValidationReceiptPointer, ["receiptId", "receiptHash", "resourceVersion", "toolsetVersion", "validationPlanIdentity", "sourceFingerprint"], "Run Toolset pointer");
  if (type === "Observation") {
    closedNested(value.identity, ["workId", "taskId", "logicalSessionId", "providerBindingId", "bindingGeneration", "repositoryId", "worktreeId", "turnId"], "Observation identity");
    closedNested(value.versions, ["catalogVersion", "desiredMaterializationVersion", "appliedMaterializationVersion", "toolsetVersion", "sourceFingerprint", "providerCapabilityRevision"], "Observation versions");
  }
  if (type === "ObservationExport") {
    if (!Array.isArray(value.sourceReceiptIds) || value.sourceReceiptIds.length === 0) throw benchmarkError("BENCHMARK_OBSERVATION_INCOMPLETE", "Observation export lacks source receipts.", "observation_export");
  }
  if (type === "SearchReceipt") {
    const allNull = value.runIsolationReceiptRef == null && value.cleanupReceiptRef == null && value.runId == null;
    const allSet = value.runIsolationReceiptRef != null && value.cleanupReceiptRef != null && typeof value.runId === "string";
    if (!allNull && !allSet) throw benchmarkError("BENCHMARK_RUN_CLEANUP_MISMATCH", "Search isolation references must be all null or all present.", "search");
  }
}

function closedNested(value, fields, label) {
  assertClosedObject(value, fields, label);
  for (const field of fields) if (!Object.hasOwn(value, field)) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", `${label} is missing ${field}.`, label);
}

function pick(value, fields) { return Object.fromEntries(fields.map((field) => [field, value?.[field]])); }

function contentHashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function mismatch() {
  throw benchmarkError("BENCHMARK_DEPENDENCY_CONTRACT_MISMATCH", "Fixed dependency contract does not match the approved Manifest.", "manifest");
}
