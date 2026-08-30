import {
  CLEANUP_RECEIPT_ARTIFACT,
  RUN_RECEIPT_ARTIFACT,
  canonicalJson,
  contractError,
  projectToolsetReceiptRef,
  runStartupBindingReceiptRef,
  snapshotReceiptRef,
  validateRunIsolationReceiptSchema,
  verifyReceiptHash
} from "./projectCodeContracts.mjs";

const runFields = new Set([
  "schemaVersion", "receiptId", "receiptHash", "runId", "mode", "logicalSessionId", "workItemId",
  "repositoryId", "worktreeId", "sourceFingerprint", "startupBindingReceiptRef",
  "repositorySourceSnapshotReceiptRef", "toolsetValidationReceiptPointer", "state", "outcome", "runContextHash",
  "dataRootBindingId", "processLeaseRefs", "portLeaseRefs", "dataLeaseRef", "credentialLeaseRefs",
  "fencingToken", "resourceVersion", "eventRefs", "metricsRef", "readyAt", "startedAt", "stoppedAt",
  "completedAt", "error"
]);
const cleanupFields = new Set([
  "schemaVersion", "receiptId", "receiptHash", "cleanupOperationId", "runId", "runReceiptRef",
  "logicalSessionId", "workItemId", "repositoryId", "worktreeId", "sourceFingerprint", "outcome", "policy",
  "ownerSessionId", "retentionReason", "retentionPolicyVersion", "retainUntil", "quotaBytes", "observedBytes",
  "fencingToken", "resourceVersion", "dataRootBindingId", "sourceIdentityHash", "trashIdentityHash", "safetyChecks",
  "processReconciliation", "bytesReclaimed", "filesRemoved", "eventRefs", "startedAt", "finishedAt", "error"
]);

export class ProjectCodeRunIsolationPort {
  constructor(options = {}) {
    if (!options.service) throw new TypeError("ProjectCodeRunIsolationPort requires RunIsolationService.");
    this.service = options.service;
    this.commandDescriptors = options.commandDescriptors ?? null;
    this.capabilities = Object.freeze({
      localSemantic: options.capabilities?.localSemantic === true,
      networkAccess: false,
      languages: Object.freeze([...(options.capabilities?.languages ?? [])])
    });
  }

  async prepareRun(input) {
    const snapshot = input.snapshot;
    const toolsetPointer = input.toolsetValidationReceipt
      ? projectToolsetReceiptRef(input.toolsetValidationReceipt, snapshot.receipt.sourceFingerprint)
      : null;
    const request = Object.freeze({
      startupBindingReceiptRef: runStartupBindingReceiptRef(snapshot.startupReceipt),
      repositorySourceSnapshotReceiptRef: snapshotReceiptRef(snapshot.receipt),
      toolsetValidationReceiptPointer: toolsetPointer,
      testPlanRef: null,
      fixtureRef: null,
      baseSnapshotRef: null,
      retentionPolicyRef: input.retentionPolicyRef ?? "retention:ephemeral-search-v1",
      quotaClass: input.quotaClass ?? "project_code_search",
      idempotencyKey: input.idempotencyKey
    });
    const prepared = await this.service.prepareRun(request, authenticatedSession(input));
    const context = prepared?.runContext ?? prepared;
    if (!context?.runId || !Number.isInteger(context.resourceVersion) || !Number.isInteger(context.fencingToken)) {
      throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", "RunIsolation prepareRun returned no valid RunContext.");
    }
    if (context.logicalSessionId !== input.sessionContext.logicalSessionId
      || context.workItemId !== input.sessionContext.workItemId
      || context.repositoryId !== snapshot.receipt.repositoryId
      || context.worktreeId !== snapshot.receipt.worktreeId
      || context.sourceFingerprint !== snapshot.receipt.sourceFingerprint) {
      throw contractError("RUN_SOURCE_FINGERPRINT_MISMATCH", "Prepared RunContext does not match the authoritative Session/Snapshot identity.");
    }
    return Object.freeze({ ...prepared, runContext: Object.freeze({ ...context }), toolsetValidationReceiptPointer: toolsetPointer });
  }

  async execute(input) {
    const context = input.prepared.runContext;
    const commandDescriptorRef = await this.#createCommandDescriptor(input, context);
    const request = Object.freeze({
      runId: context.runId,
      preparedResourceVersion: context.resourceVersion,
      fencingToken: context.fencingToken,
      commandDescriptorRef,
      toolsetValidationReceiptPointer: input.prepared.toolsetValidationReceiptPointer,
      idempotencyKey: input.idempotencyKey
    });
    const response = await this.service.execute(request, authenticatedSession(input));
    const receipt = response?.receipt ?? response;
    await validateRunReceipt(
      receipt,
      input.snapshot,
      input.sessionContext,
      context.runId,
      input.prepared.toolsetValidationReceiptPointer
    );
    const results = response?.results
      ?? (typeof this.service.readSemanticResults === "function"
        ? await this.service.readSemanticResults(context.runId, authenticatedSession(input))
        : []);
    return Object.freeze({ receipt, results: Object.freeze([...(results ?? [])]) });
  }

  async cleanup(input) {
    const context = input.prepared.runContext;
    const request = Object.freeze({
      runId: context.runId,
      policy: input.policy ?? "success_default",
      expectedResourceVersion: input.expectedResourceVersion,
      fencingToken: context.fencingToken,
      idempotencyKey: input.idempotencyKey
    });
    const response = await this.service.cleanup(request, authenticatedSession(input));
    const receipt = response?.receipt ?? response;
    await validateCleanupReceipt(receipt, input.snapshot, input.sessionContext, context.runId);
    if (receipt.outcome !== "cleaned") {
      throw contractError(
        receipt.outcome === "unknown" ? "RUN_CLEANUP_OUTCOME_UNKNOWN" : "RUN_CLEANUP_BLOCKED",
        `RunIsolation cleanup did not reach cleaned: ${receipt.outcome}.`,
        503
      );
    }
    return Object.freeze({ receipt });
  }

  async #createCommandDescriptor(input, context) {
    if (!this.commandDescriptors?.create) {
      throw contractError("RUN_ISOLATION_REQUIRED_FAILED", "RunIsolation command descriptor storage is unavailable.", 503);
    }
    return this.commandDescriptors.create({
      type: "project-code-semantic-query",
      runId: context.runId,
      query: input.query,
      queryHash: input.queryHash,
      limit: input.limit,
      sourceFingerprint: input.snapshot.receipt.sourceFingerprint
    });
  }
}

export function runReceiptRef(receipt) {
  return receiptRef(receipt, RUN_RECEIPT_ARTIFACT, "RunReceipt");
}

export function cleanupReceiptRef(receipt) {
  return receiptRef(receipt, CLEANUP_RECEIPT_ARTIFACT, "CleanupReceipt");
}

export async function validateRunReceipt(receipt, snapshot, sessionContext, runId, toolsetValidationReceiptPointer = null) {
  assertClosed(receipt, runFields, "RunReceipt");
  await validateRunIsolationReceiptSchema(receipt, "RunReceipt");
  verifyReceiptHash(receipt, "RUN_RECEIPT_HASH_MISMATCH");
  if (receipt.schemaVersion !== 6 || receipt.runId !== runId) throw contractError("RUN_RECEIPT_REFERENCE_MISMATCH", "RunReceipt v6 identity mismatch.");
  assertSourceIdentity(receipt, snapshot, sessionContext);
  if (!sameJson(receipt.toolsetValidationReceiptPointer, toolsetValidationReceiptPointer)) {
    throw contractError("RUN_TOOLSET_POINTER_MISMATCH", "RunReceipt Toolset pointer does not match the verified full Toolset receipt.");
  }
  if (!sameJson(receipt.startupBindingReceiptRef, runStartupBindingReceiptRef(snapshot.startupReceipt))) {
    throw contractError("RUN_STARTUP_BINDING_MISMATCH", "RunReceipt does not reference the authoritative Startup binding receipt.");
  }
  if (!sameJson(receipt.repositorySourceSnapshotReceiptRef, snapshotReceiptRef(snapshot.receipt))) {
    throw contractError("SOURCE_SNAPSHOT_IDENTITY_MISMATCH", "RunReceipt does not reference the authoritative Snapshot receipt.");
  }
  if (!["completed", "failed", "cancelled"].includes(receipt.state)) {
    throw contractError("RUN_STATE_CONFLICT", `Semantic execute returned non-terminal RunReceipt state ${receipt.state}.`);
  }
  assertTimeOrder([receipt.readyAt, receipt.startedAt, receipt.stoppedAt, receipt.completedAt]);
  return receipt;
}

export async function validateCleanupReceipt(receipt, snapshot, sessionContext, runId) {
  assertClosed(receipt, cleanupFields, "CleanupReceipt");
  await validateRunIsolationReceiptSchema(receipt, "CleanupReceipt");
  verifyReceiptHash(receipt, "CLEANUP_RECEIPT_HASH_MISMATCH");
  if (receipt.schemaVersion !== 4 || receipt.runId !== runId) throw contractError("RUN_RECEIPT_REFERENCE_MISMATCH", "CleanupReceipt v4 identity mismatch.");
  assertSourceIdentity(receipt, snapshot, sessionContext);
  validateCleanupSemantics(receipt);
  assertTimeOrder([receipt.startedAt, receipt.finishedAt]);
  return receipt;
}

function receiptRef(receipt, artifact, receiptType) {
  return Object.freeze({
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    schemaVersion: artifact.schemaVersion,
    resourceVersion: receipt.resourceVersion,
    artifactRef: Object.freeze({ ...artifact, receiptType }),
    runId: receipt.runId
  });
}

function assertSourceIdentity(receipt, snapshot, sessionContext) {
  if (receipt.logicalSessionId !== sessionContext.logicalSessionId
    || receipt.workItemId !== sessionContext.workItemId
    || receipt.repositoryId !== snapshot.receipt.repositoryId
    || receipt.worktreeId !== snapshot.receipt.worktreeId
    || receipt.sourceFingerprint !== snapshot.receipt.sourceFingerprint) {
    throw contractError("RUN_SOURCE_FINGERPRINT_MISMATCH", "RunIsolation receipt source identity mismatch.");
  }
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateCleanupSemantics(receipt) {
  const checks = Object.values(receipt.safetyChecks ?? {});
  for (const check of checks) {
    if (check.status === "passed" && (check.errorCode !== null || check.evidenceHash === null)) {
      throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", "A passed Cleanup safety check requires evidence and no error code.");
    }
    if (["failed", "indeterminate"].includes(check.status) && (check.errorCode === null || check.evidenceHash === null)) {
      throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", "A failed or indeterminate Cleanup safety check requires error and evidence.");
    }
    if (check.status === "not_applicable"
      && (receipt.outcome !== "retained" || check.errorCode !== null || check.evidenceHash !== null)) {
      throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", "Cleanup not_applicable checks are valid only for retained, unstarted deletion.");
    }
  }
  if (["blocked", "quarantined", "unknown"].includes(receipt.outcome)
    && !checks.some((check) => ["failed", "indeterminate"].includes(check.status))
    && !["indeterminate", "foreign", "pidReused"].includes(receipt.processReconciliation)) {
    throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", `${receipt.outcome} Cleanup requires concrete failed or indeterminate safety evidence.`);
  }
}

function assertClosed(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", `${label} must be an object.`);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  const missing = [...fields].filter((field) => !Object.hasOwn(value, field));
  if (unknown.length || missing.length) {
    throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", `${label} closed fields mismatch (unknown=${unknown.join(",")}; missing=${missing.join(",")}).`);
  }
}

function assertTimeOrder(values) {
  const times = values.filter((value) => value !== null).map((value) => Date.parse(value));
  if (times.some((value) => !Number.isFinite(value)) || times.some((value, index) => index > 0 && value < times[index - 1])) {
    throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", "RunIsolation receipt timestamps are not monotonic RFC3339 values.");
  }
}

function authenticatedSession(input) {
  return Object.freeze({
    logicalSessionId: input.sessionContext.logicalSessionId,
    workItemId: input.sessionContext.workItemId,
    objectiveId: input.sessionContext.objectiveId
  });
}
