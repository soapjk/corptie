import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RunIsolationAuthorityResolver } from "../runIsolation/runIsolationAuthorityResolver.mjs";
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
  "schemaVersion", "receiptId", "receiptHash", "runId", "mode", "logicalSessionId", "taskId",
  "repositoryId", "worktreeId", "sourceFingerprint", "startupBindingReceiptRef",
  "repositorySourceSnapshotReceiptRef", "toolsetValidationReceiptPointer", "state", "outcome", "runContextHash",
  "dataRootBindingId", "processLeaseRefs", "portLeaseRefs", "dataLeaseRef", "credentialLeaseRefs",
  "fencingToken", "resourceVersion", "eventRefs", "metricsRef", "readyAt", "startedAt", "stoppedAt",
  "completedAt", "error"
]);
const cleanupFields = new Set([
  "schemaVersion", "receiptId", "receiptHash", "cleanupOperationId", "runId", "runReceiptRef",
  "logicalSessionId", "taskId", "repositoryId", "worktreeId", "sourceFingerprint", "outcome", "policy",
  "ownerSessionId", "retentionReason", "retentionPolicyVersion", "retainUntil", "quotaBytes", "observedBytes",
  "fencingToken", "resourceVersion", "dataRootBindingId", "sourceIdentityHash", "trashIdentityHash", "safetyChecks",
  "processReconciliation", "bytesReclaimed", "filesRemoved", "eventRefs", "startedAt", "finishedAt", "error"
]);

export class ProjectCodeRunIsolationPort {
  constructor(options = {}) {
    if (!options.coordinator) throw new TypeError("ProjectCodeRunIsolationPort requires RunIsolationExecutionCoordinator.");
    this.coordinator = options.coordinator;
    this.semanticWorkerPath = options.semanticWorkerPath
      ?? fileURLToPath(new URL("./projectCodeSemanticWorker.mjs", import.meta.url));
    this.capabilities = Object.freeze({
      localSemantic: options.capabilities?.localSemantic === true,
      networkAccess: false,
      languages: Object.freeze([...(options.capabilities?.languages ?? [])])
    });
  }

  async prepareRun(input) {
    const snapshot = input.snapshot;
    if (!input.toolsetValidationReceipt) {
      throw contractError("TOOLSET_CONTRACT_UNRESOLVED", "Production L3 requires an authoritative ToolsetValidationReceipt v3.", 503);
    }
    const toolsetPointer = projectToolsetReceiptRef(input.toolsetValidationReceipt, snapshot.receipt.sourceFingerprint);
    const startupBindingReceiptRef = runStartupBindingReceiptRef(snapshot.startupReceipt);
    const repositorySourceSnapshotReceiptRef = snapshotReceiptRef(snapshot.receipt);
    const session = authenticatedSession(input, snapshot);
    const authorityResolver = new RunIsolationAuthorityResolver({
      resolveAuthority: async () => Object.freeze({
        logicalSessionId: session.logicalSessionId,
        taskId: session.taskId,
        repositoryId: session.repositoryId,
        worktreeId: session.worktreeId,
        bindingId: snapshot.startupReceipt.providerBindingId,
        bindingGeneration: snapshot.startupReceipt.bindingGeneration,
        startupBindingReceiptRef,
        repositorySourceSnapshotReceiptRef,
        toolsetValidationReceiptPointer: toolsetPointer
      })
    });
    const authority = await authorityResolver.resolve(Object.freeze({
      logicalSessionId: session.logicalSessionId,
      taskId: session.taskId,
      repositoryId: session.repositoryId,
      worktreeId: session.worktreeId,
      action: "verify",
      bindingId: snapshot.startupReceipt.providerBindingId,
      bindingGeneration: snapshot.startupReceipt.bindingGeneration
    }));
    const request = Object.freeze({
      mode: "development",
      sourceAware: true,
      startupBindingReceiptRef: authority.startupBindingReceiptRef,
      repositorySourceSnapshotReceiptRef: authority.repositorySourceSnapshotReceiptRef,
      toolsetValidationReceiptPointer: authority.toolsetValidationReceiptPointer,
      toolsetRequired: true,
      testPlanRef: null,
      fixtureRef: null,
      quotaClass: input.quotaClass ?? "project_code_search",
      idempotencyKey: input.idempotencyKey
    });
    const resolveToolsetReceipt = async (receiptId) => receiptId === input.toolsetValidationReceipt.receiptId
      ? input.toolsetValidationReceipt
      : null;
    const prepared = await this.coordinator.prepareRun(request, session, { toolsetReceiptResolver: resolveToolsetReceipt });
    const context = prepared?.context ?? prepared?.runContext ?? prepared;
    if (!context?.runId || !Number.isInteger(context.resourceVersion) || !Number.isInteger(context.fencingToken)) {
      throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", "RunIsolation prepareRun returned no valid RunContext.");
    }
    if (context.logicalSessionId !== input.sessionContext.logicalSessionId
      || context.taskId !== input.sessionContext.taskId
      || context.repositoryId !== snapshot.receipt.repositoryId
      || context.worktreeId !== snapshot.receipt.worktreeId
      || context.sourceFingerprint !== snapshot.receipt.sourceFingerprint) {
      throw contractError("RUN_SOURCE_FINGERPRINT_MISMATCH", "Prepared RunContext does not match the authoritative Session/Snapshot identity.");
    }
    return Object.freeze({
      ...prepared,
      runContext: Object.freeze({ ...context }),
      toolsetValidationReceiptPointer: toolsetPointer,
      resolveToolsetReceipt
    });
  }

  async execute(input) {
    const context = input.prepared.runContext;
    const requestPath = `${context.tmpDir}/project-code-semantic-request.json`;
    await writeFile(requestPath, JSON.stringify({
      schemaVersion: 1,
      query: input.query,
      limit: input.limit,
      sourceFingerprint: input.snapshot.receipt.sourceFingerprint,
      candidates: input.snapshot.candidates.map(({ path, language }) => ({ path, language }))
    }), { mode: 0o600, flag: "wx" });
    const session = authenticatedSession(input, input.snapshot);
    let cancellation = null;
    const cancel = async () => {
      const current = this.coordinator.service.inspect(context.runId, session);
      cancellation ??= this.coordinator.cancel({
        runId: current.runId,
        expectedResourceVersion: current.resourceVersion,
        fencingToken: current.fencingToken,
        idempotencyKey: `${input.idempotencyKey}:cancel`
      }, session);
      return cancellation;
    };
    if (input.signal?.aborted) {
      const receipt = await cancel();
      await validateRunReceipt(receipt, input.snapshot, input.sessionContext, context.runId, input.prepared.toolsetValidationReceiptPointer);
      return Object.freeze({ receipt, results: Object.freeze([]) });
    }
    const abort = () => { cancel().catch(() => {}); };
    input.signal?.addEventListener("abort", abort, { once: true });
    let receipt;
    try {
      receipt = await this.coordinator.execute({
        runContext: context,
        descriptor: {
          executable: process.execPath,
          args: [this.semanticWorkerPath, requestPath],
          cwd: input.snapshot.canonicalWorktreePath,
          role: "project-code-semantic",
          timeoutMilliseconds: 30_000,
          captureOutput: true,
          environment: {}
        },
        idempotencyKey: input.idempotencyKey,
        toolsetReceiptResolver: input.prepared.resolveToolsetReceipt
      }, session);
      if (cancellation) await cancellation;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
    await validateRunReceipt(
      receipt,
      input.snapshot,
      input.sessionContext,
      context.runId,
      input.prepared.toolsetValidationReceiptPointer
    );
    const output = this.coordinator.service.takeCommandOutput(context.runId);
    const results = receipt.state === "completed" && receipt.outcome === "passed"
      ? parseSemanticOutput(output, input.snapshot.receipt.sourceFingerprint)
      : [];
    return Object.freeze({ receipt, results: Object.freeze(results) });
  }

  async cleanup(input) {
    const context = input.prepared.runContext;
    const session = authenticatedSession(input, input.snapshot);
    const receipt = this.coordinator.service.store?.latestCleanupReceipt?.(context.runId)
      ?? this.coordinator.service.store?.latestCleanup?.(context.runId)?.receipt
      ?? await cleanupCurrentRun(this.coordinator, context.runId, input.policy, input.idempotencyKey, session);
    await validateCleanupReceipt(receipt, input.snapshot, input.sessionContext, context.runId);
    if (!['cleaned', 'retained'].includes(receipt.outcome)) {
      throw contractError(
        receipt.outcome === "unknown" ? "RUN_CLEANUP_OUTCOME_UNKNOWN" : "RUN_CLEANUP_BLOCKED",
        `RunIsolation cleanup did not reach cleaned: ${receipt.outcome}.`,
        503
      );
    }
    return Object.freeze({ receipt });
  }
}

async function cleanupCurrentRun(coordinator, runId, policy, idempotencyKey, session) {
  const current = coordinator.service.inspect(runId, session);
  return coordinator.cleanup({
    runId: current.runId,
    policy: policy ?? "success_default",
    expectedResourceVersion: current.resourceVersion,
    fencingToken: current.fencingToken,
    idempotencyKey
  }, session);
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
    || receipt.taskId !== sessionContext.taskId
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

function authenticatedSession(input, snapshot = input.snapshot) {
  return Object.freeze({
    logicalSessionId: input.sessionContext.logicalSessionId,
    taskId: input.sessionContext.taskId,
    workId: input.sessionContext.workId,
    repositoryId: snapshot.receipt.repositoryId,
    worktreeId: snapshot.receipt.worktreeId
  });
}

function parseSemanticOutput(output, sourceFingerprint) {
  let parsed;
  try { parsed = JSON.parse(String(output ?? "")); }
  catch { throw contractError("RUN_EXECUTION_FAILED", "Semantic worker returned invalid JSON.", 503); }
  if (parsed?.schemaVersion !== 1 || parsed?.sourceFingerprint !== sourceFingerprint || !Array.isArray(parsed.results)) {
    throw contractError("RUN_SOURCE_FINGERPRINT_MISMATCH", "Semantic worker output does not close over the authoritative Snapshot.");
  }
  return parsed.results;
}
