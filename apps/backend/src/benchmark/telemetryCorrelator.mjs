import { benchmarkError, contentHash } from "./canonical.mjs";
import { DEPENDENCY_MANIFEST_IDENTITY, validateReceiptEnvelope } from "./contracts.mjs";

const CHAIN_FIELDS = ["objectiveId", "workItemId", "logicalSessionId", "providerBindingId", "providerBindingGeneration", "repositoryId", "worktreeId", "catalogVersion", "toolsetVersion", "sourceFingerprint", "runId", "observationId"];

export class TelemetryCorrelator {
  correlate({ attemptId, receipts, evidenceRefs = [], expectedScope, now = Date.now() }) {
    const byType = new Map();
    for (const envelope of receipts) {
      validateReceiptEnvelope(envelope, { now });
      if (byType.has(envelope.receiptType)) throw benchmarkError("BENCHMARK_RECEIPT_SCHEMA_INVALID", `Duplicate ${envelope.receiptType}.`, "correlation");
      byType.set(envelope.receiptType, envelope);
    }
    const required = ["ToolHostAppliedReceipt", "StartupBindingReceipt", "RepositorySourceSnapshotReceipt", "ToolsetValidationReceipt", "RunReceipt", "CleanupReceipt", "Observation", "ObservationExport"];
    for (const type of required) if (!byType.has(type)) throw benchmarkError("ATTEMPT_IDENTITY_INCOMPLETE", `Correlation requires ${type}.`, "correlation");
    const toolHost = payload(byType, "ToolHostAppliedReceipt");
    const startup = payload(byType, "StartupBindingReceipt");
    const snapshot = payload(byType, "RepositorySourceSnapshotReceipt");
    const toolset = payload(byType, "ToolsetValidationReceipt");
    const run = payload(byType, "RunReceipt");
    const cleanup = payload(byType, "CleanupReceipt");
    const observation = payload(byType, "Observation");
    const observationExport = payload(byType, "ObservationExport");
    const chain = {
      objectiveId: startup.objectiveId, workItemId: startup.workItemId, logicalSessionId: startup.logicalSessionId,
      providerBindingId: startup.providerBindingId, providerBindingGeneration: startup.bindingGeneration,
      repositoryId: startup.repositoryId, worktreeId: startup.worktreeId, catalogVersion: toolHost.appliedCatalogVersion,
      toolsetVersion: toolset.toolsetVersion, sourceFingerprint: snapshot.sourceFingerprint, runId: run.runId,
      observationId: observation.observationId
    };
    for (const field of CHAIN_FIELDS) if (chain[field] == null || chain[field] === "") throw benchmarkError("ATTEMPT_IDENTITY_INCOMPLETE", `Attempt identity is missing ${field}.`, "correlation");
    if (expectedScope && (chain.logicalSessionId !== expectedScope.logicalSessionId || chain.objectiveId !== expectedScope.objectiveId || chain.workItemId !== expectedScope.workItemId)) mismatch("Authenticated Session scope does not match receipts.");
    same(chain.logicalSessionId, snapshot.logicalSessionId, toolset.identity?.logicalSessionId, run.logicalSessionId, cleanup.logicalSessionId, observation.identity?.logicalSessionId);
    same(chain.workItemId, snapshot.workItemId, toolset.identity?.workItemId, run.workItemId, cleanup.workItemId, observation.identity?.workItemId);
    same(chain.repositoryId, snapshot.repositoryId, toolset.identity?.repositoryId, run.repositoryId, cleanup.repositoryId, observation.identity?.repositoryId);
    same(chain.worktreeId, snapshot.worktreeId, toolset.identity?.worktreeId, run.worktreeId, cleanup.worktreeId, observation.identity?.worktreeId);
    same(chain.providerBindingId, toolHost.providerBindingId, observation.identity?.providerBindingId);
    same(chain.providerBindingGeneration, observation.identity?.bindingGeneration);
    same(chain.catalogVersion, observation.versions?.catalogVersion);
    same(chain.sourceFingerprint, toolset.snapshotRef?.sourceFingerprint, run.sourceFingerprint, cleanup.sourceFingerprint);
    same(chain.runId, cleanup.runId);
    if (observation.runId != null) same(chain.runId, observation.runId);
    same(run.receiptId, cleanup.runReceiptRef?.receiptId);
    same(chain.logicalSessionId, observationExport.identity?.logicalSessionId);
    same(chain.providerBindingId, observationExport.identity?.providerBindingId);
    same(chain.providerBindingGeneration, observationExport.identity?.bindingGeneration);
    same(chain.catalogVersion, observationExport.versions?.catalogVersion);
    if (observationExport.versions?.toolsetVersion != null) same(chain.toolsetVersion, observationExport.versions.toolsetVersion);
    if (observationExport.versions?.sourceFingerprint != null) same(chain.sourceFingerprint, observationExport.versions.sourceFingerprint);
    if (!observationExport.sourceReceiptIds.includes(byType.get("Observation").receiptId)) throw benchmarkError("BENCHMARK_OBSERVATION_INCOMPLETE", "Observation export does not reference its authority Observation.", "observation_export");
    if (run.repositorySourceSnapshotReceiptRef?.receiptId !== snapshot.receiptId || toolset.snapshotRef?.receiptId !== snapshot.receiptId) sourceMismatch();
    if (run.toolsetValidationReceiptPointer && (run.toolsetValidationReceiptPointer.receiptId !== toolset.receiptId || run.toolsetValidationReceiptPointer.toolsetVersion !== toolset.toolsetVersion || run.toolsetValidationReceiptPointer.sourceFingerprint !== snapshot.sourceFingerprint)) mismatch("Run Toolset pointer mismatch.");
    if (cleanup.outcome !== "cleaned") throw benchmarkError("BENCHMARK_RUN_CLEANUP_MISMATCH", "Cleanup did not produce clean outcome.", "cleanup");
    const search = byType.has("SearchReceipt") ? payload(byType, "SearchReceipt") : null;
    if (search) {
      same(chain.sourceFingerprint, search.sourceFingerprint, search.snapshotReceiptRef?.sourceFingerprint);
      if (search.snapshotReceiptRef?.receiptId !== snapshot.receiptId || search.toolsetValidationReceiptRef?.receiptId !== toolset.receiptId) sourceMismatch();
      if (search.runId != null) same(chain.runId, search.runId, search.runIsolationReceiptRef?.runId, search.cleanupReceiptRef?.runId);
    }
    const identityChainHash = contentHash(chain);
    return Object.freeze({
      schemaVersion: 1, attemptId, identityChain: chain, identityChainHash,
      receiptRefs: receipts.map((item) => ({ receiptId: item.receiptId, receiptType: item.receiptType, producerServiceId: item.producerServiceId, contentHash: item.contentHash })),
      evidenceRefs: [...evidenceRefs], manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY,
      correlatedAt: new Date(now).toISOString(), correlationStatus: "complete"
    });
  }
}

function payload(map, type) { return map.get(type).payload; }
function same(...values) { if (new Set(values).size !== 1 || values.some((value) => value == null)) mismatch("Receipt identity chain mismatch."); }
function mismatch(message) { throw benchmarkError("BENCHMARK_IDENTITY_CHAIN_MISMATCH", message, "correlation"); }
function sourceMismatch() { throw benchmarkError("BENCHMARK_SOURCE_FINGERPRINT_MISMATCH", "Snapshot/source authority references do not match.", "correlation"); }

export { CHAIN_FIELDS as ATTEMPT_IDENTITY_FIELDS };
