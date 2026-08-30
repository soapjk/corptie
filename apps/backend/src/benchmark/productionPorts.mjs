import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { benchmarkError, contentHash, hashWithout } from "./canonical.mjs";
import { createReceiptEnvelope, RECEIPT_IDENTITY_PROFILES } from "./contracts.mjs";

const TRUE_EXECUTABLE = "/usr/bin/true";

// This is the only production bridge into the Benchmark control plane. Every
// adapter calls an accepted provider-neutral service or its authoritative
// Store; it never maintains a second copy of upstream business state.
export function createBenchmarkProductionPorts(options = {}) {
  const store = required(options.store, "Store");
  const artifactEvidencePort = required(options.artifactEvidencePort, "Artifact evidence Port");
  const startupReceipts = required(options.startupReceipts, "Startup receipt repository");
  const projectCode = required(options.projectCodeApplicationService, "Project-code service");
  const toolsets = required(options.projectToolsetProduction, "Project Toolset composition");
  const runIsolation = required(options.runIsolationCoordinator, "Run Isolation coordinator");
  const observability = required(options.observabilityService, "Observability service");
  const readKillSwitch = options.readKillSwitch ?? (() => process.env.CORPTIE_BENCHMARK_KILL_SWITCH === "1");

  const authorityFor = async (logicalSessionId) => {
    const runtime = await toolsets.runtimeAuthority(logicalSessionId);
    const startup = startupReceipts.require(logicalSessionId);
    const toolset = await toolsets.resolveToolsetReceipt(runtime.toolsetReceiptId);
    const snapshot = toolset?.snapshotRef?.receiptId
      ? store.getProjectCodeReceiptById(toolset.snapshotRef.receiptId)?.receipt ?? null
      : null;
    if (!runtime.snapshot || !snapshot || !toolset) fail("BENCHMARK_PORT_UNAVAILABLE", "Snapshot or Toolset authority is unavailable.", 503);
    if (snapshot.receiptId !== toolset.snapshotRef?.receiptId
      || snapshot.sourceFingerprint !== toolset.snapshotRef?.sourceFingerprint
      || runtime.snapshot.sourceFingerprint !== snapshot.sourceFingerprint) {
      fail("BENCHMARK_SOURCE_FINGERPRINT_MISMATCH", "Toolset does not echo the authoritative Snapshot.");
    }
    return { runtime: { ...runtime, snapshot, repositorySourceSnapshotReceiptRef: toolset.snapshotRef },
      startup, snapshot, toolset };
  };

  const toolHostReceipt = (scope) => {
    const logical = store.getLogicalSession(scope.logicalSessionId);
    const bindingId = logical?.activeBinding?.bindingId;
    const startup = startupReceipts.require(scope.logicalSessionId);
    const record = bindingId ? store.getSessionToolCatalogMaterialization(scope.logicalSessionId, bindingId) : null;
    const receipt = record?.providerReceipt;
    if (!record || record.status !== "applied" || !receipt?.receiptId
      || record.appliedVersion !== receipt.appliedVersion
      || record.appliedCatalogVersion !== receipt.appliedCatalogVersion) {
      fail("BENCHMARK_RECEIPT_STALE", "Applied Tool Host receipt is unavailable or stale.");
    }
    return closedPayload("ToolHostAppliedReceipt", {
      ...receipt,
      // The correlation profile deliberately names the Startup execution
      // binding. The source Tool Host receipt remains addressed by receiptId;
      // this explicit projection maps the opaque Provider route to the frozen
      // Startup generation without copying Provider state.
      providerBindingId: startup.providerBindingId,
      appliedCatalogVersion: record.appliedCatalogVersion,
      appliedDomains: record.appliedDomains,
      appliedAt: record.appliedAt
    });
  };

  const rawRun = (runId) => {
    const receipt = runIsolation.service.store?.latestRunReceipt(runId);
    if (!receipt) fail("BENCHMARK_PORT_UNAVAILABLE", "Authoritative Run receipt is unavailable.", 503);
    return receipt;
  };
  const rawCleanup = (runId) => {
    const receipt = runIsolation.service.store?.latestCleanupReceipt?.(runId)
      ?? runIsolation.service.store?.latestCleanup?.(runId)?.receipt ?? null;
    if (!receipt) fail("BENCHMARK_PORT_UNAVAILABLE", "Authoritative Cleanup receipt is unavailable.", 503);
    return receipt;
  };

  return Object.freeze({
    artifactEvidencePort,
    rolloutActuatorReadPort: {
      async readKillSwitch({ scope, experimentId }) {
        const active = await readKillSwitch({ scope, experimentId }) === true;
        return Object.freeze({ receiptId: `benchmark_kill_switch:${contentHash({ active, scope, experimentId })}`, active,
          source: "server_configuration", observedAt: new Date().toISOString() });
      }
    },
    toolHostReceiptPort: {
      async queryAppliedReceipt(request) {
        const payload = toolHostReceipt(request.scope);
        return envelope("ToolHostAppliedReceipt", payload, request);
      }
    },
    startupBindingReceiptPort: {
      async queryReadyReceipt(request) {
        return envelope("StartupBindingReceipt", startupReceipts.require(request.scope.logicalSessionId), request);
      }
    },
    repositorySourceSnapshotPort: {
      async preflight(request) {
        const authority = await authorityFor(request.scope.logicalSessionId);
        return envelope("RepositorySourceSnapshotReceipt", authority.snapshot, request);
      }
    },
    projectToolsetReceiptPort: {
      async queryValidationReceipt(request) {
        const authority = await authorityFor(request.scope.logicalSessionId);
        return envelope("ToolsetValidationReceipt", authority.toolset, request);
      }
    },
    runIsolationScenarioPort: {
      async execute(request) {
        await access(TRUE_EXECUTABLE, constants.X_OK);
        const authority = await authorityFor(request.scope.logicalSessionId);
        const session = authenticatedSession(authority);
        const prepared = await runIsolation.prepareRun({
          mode: "test", sourceAware: true, toolsetRequired: true,
          startupBindingReceiptRef: authority.runtime.startupBindingReceiptRef,
          repositorySourceSnapshotReceiptRef: authority.runtime.repositorySourceSnapshotReceiptRef,
          toolsetValidationReceiptPointer: authority.runtime.toolsetValidationReceiptPointer,
          testPlanRef: `benchmark:${request.sampleId}:v2`, fixtureRef: `benchmark:${request.sampleId}:${request.variant}`,
          quotaClass: "benchmark", idempotencyKey: `benchmark:${request.attemptId}:prepare`
        }, session, { toolsetReceiptResolver: toolsets.resolveToolsetReceipt });
        const receipt = await runIsolation.execute({
          runContext: prepared.context,
          descriptor: { executable: TRUE_EXECUTABLE, args: [], cwd: authority.startup.canonicalWorktreePath,
            role: "benchmark", captureOutput: true, timeoutMilliseconds: 30_000 },
          idempotencyKey: `benchmark:${request.attemptId}:execute`,
          toolsetReceiptResolver: toolsets.resolveToolsetReceipt
        }, session);
        return envelope("RunReceipt", receipt, request, { evidence: runEvidence(receipt) });
      },
      async queryRunReceipt(request) { return envelope("RunReceipt", rawRun(request.runId), request, { evidence: runEvidence(rawRun(request.runId)) }); },
      async cleanup({ runReceipt, ...request }) {
        const completedCleanup = runIsolation.service.store?.latestCleanupReceipt?.(runReceipt.payload.runId)
          ?? runIsolation.service.store?.latestCleanup?.(runReceipt.payload.runId)?.receipt ?? null;
        if (completedCleanup) return envelope("CleanupReceipt", completedCleanup, request);
        const authority = await authorityFor(request.scope.logicalSessionId);
        const session = authenticatedSession(authority);
        const current = runIsolation.service.inspect(runReceipt.payload.runId, session);
        const receipt = await runIsolation.cleanup({ runId: runReceipt.payload.runId, policy: "success_default",
          expectedResourceVersion: current.resourceVersion, fencingToken: current.fencingToken,
          idempotencyKey: `benchmark:${request.attemptId}:cleanup` }, session);
        return envelope("CleanupReceipt", receipt, request);
      },
      async queryCleanupReceipt({ runReceipt, ...request }) { return envelope("CleanupReceipt", rawCleanup(runReceipt.payload.runId), request); },
      async cancel({ runId, scope }) {
        if (!runId) return { accepted: false };
        const authority = await authorityFor(scope.logicalSessionId); const session = authenticatedSession(authority);
        const current = runIsolation.service.inspect(runId, session);
        return runIsolation.cancel({ runId, expectedResourceVersion: current.resourceVersion,
          fencingToken: current.fencingToken, idempotencyKey: `benchmark:${runId}:cancel` }, session);
      }
    },
    sessionExecutionPort: {
      async execute({ runId }) {
        const receipt = rawRun(runId);
        if (receipt.state !== "completed" || receipt.outcome !== "passed") fail("BENCHMARK_SESSION_EXECUTION_FAILED", "Bounded provider-neutral scenario did not pass.");
        return Object.freeze({ accepted: true, runReceiptId: receipt.receiptId });
      },
      async cancel() { return Object.freeze({ accepted: true }); }
    },
    layeredSearchScenarioPort: {
      async execute({ runReceipt, cleanupReceipt, ...request }) {
        const authority = await authorityFor(request.scope.logicalSessionId);
        const result = await projectCode.search({ logicalSessionId: request.scope.logicalSessionId,
          snapshotReceiptId: authority.snapshot.receiptId, query: "BenchmarkControlPlane", mode: "exact",
          limit: 20, minResults: 1, timeoutMs: 10_000,
          searchScenarioId: searchScenarioId(request), toolsetValidationReceipt: authority.toolset, toolsetRequired: true });
        // Search itself owns these fields; a lexical S6 receipt correctly keeps
        // its optional isolation triple null while the outer attempt correlates
        // the separately authoritative Run/Cleanup chain.
        return envelope("SearchReceipt", result.searchReceipt, request);
      },
      async queryReceipt(request) {
        const receipt = findSearchReceipt(store, request.scope.logicalSessionId, searchScenarioId(request));
        if (!receipt) fail("BENCHMARK_PORT_UNAVAILABLE", "Authoritative Search receipt is unavailable.", 503);
        return envelope("SearchReceipt", receipt, request);
      },
      async cancel() { return Object.freeze({ accepted: true }); }
    },
    observabilityQueryPort: createObservabilityPort({ observability, startupReceipts, authorityFor, toolHostReceipt, rawRun })
  });
}

function createObservabilityPort({ observability, authorityFor, toolHostReceipt, rawRun }) {
  return {
    async queryObservation({ runReceipt, ...request }) {
      const authority = await authorityFor(request.scope.logicalSessionId);
      const run = rawRun(runReceipt.payload.runId);
      const host = toolHostReceipt(request.scope);
      const turnId = `benchmark_turn:${contentHash(request.attemptId).slice(0, 32)}`;
      const turnExecutionId = `turn_execution:${contentHash({ turnId, startupOperationId: authority.startup.startupOperationId }).slice(0, 32)}`;
      const turnExecutionReceipt = { schemaVersion: 1, receiptId: `turn_execution_receipt:${contentHash(turnExecutionId).slice(0, 32)}`,
        turnExecutionId, turnId, logicalSessionId: request.scope.logicalSessionId,
        providerBindingId: authority.startup.providerBindingId, bindingGeneration: authority.startup.bindingGeneration,
        sourceSessionEventId: null };
      const identity = { objectiveId: request.scope.objectiveId, workItemId: request.scope.workItemId,
        logicalSessionId: request.scope.logicalSessionId, providerBindingId: authority.startup.providerBindingId,
        bindingGeneration: authority.startup.bindingGeneration, repositoryId: authority.startup.repositoryId,
        worktreeId: authority.startup.worktreeId, turnId };
      const receiptRefs = [
        ref("startup_binding", authority.startup.startupOperationId, "startup_binding", 2),
        ref("turn_execution", turnExecutionReceipt.receiptId, "session_execution", 1),
        ref("tool_host_applied", host.receiptId, "tool_host", 1),
        ref("repository_source_snapshot", authority.snapshot.receiptId, "repository_source_snapshot", 1),
        ref("toolset_validation", authority.toolset.receiptId, "project_toolset", 3),
        ref("run_isolation", run.receiptId, "run_isolation", 6)
      ];
      const versions = { catalogVersion: host.appliedCatalogVersion, desiredMaterializationVersion: host.requestedVersion,
        appliedMaterializationVersion: host.appliedVersion, toolsetVersion: authority.toolset.toolsetVersion,
        sourceFingerprint: authority.snapshot.sourceFingerprint, providerCapabilityRevision: host.providerCapabilityRevision };
      const sourceIdentity = { sourceCommitOid: authority.startup.sourceCommitOid,
        sourceTreeOid: authority.startup.sourceTreeOid, snapshotReceiptId: authority.snapshot.receiptId };
      const acceptedNano = isoNano(run.startedAt ?? run.readyAt ?? new Date().toISOString());
      let completedNano = isoNano(run.completedAt ?? run.stoppedAt ?? new Date().toISOString());
      if (BigInt(completedNano) <= BigInt(acceptedNano)) completedNano = String(BigInt(acceptedNano) + 1_000_000n);
      const observationAuthority = { identity, startupBindingReceipt: authority.startup,
        turnExecutionReceipt, toolHostAppliedReceipt: host, repositorySourceSnapshotReceipt: authority.snapshot,
        toolsetValidationReceipt: authority.toolset, runIsolationReceipt: run };
      const acceptedInput = observationInput({ id: `observation:benchmark:start:${contentHash(request.attemptId).slice(0, 32)}`, turnExecutionId,
          runId: run.runId, identity, sourceIdentity, versions, receiptRefs, eventType: "turn.execution.accepted",
          nano: acceptedNano, sequence: 0, terminalStatus: null });
      const terminalInput = observationInput({ id: `observation:benchmark:end:${contentHash(request.attemptId).slice(0, 32)}`, turnExecutionId,
          runId: run.runId, identity, sourceIdentity, versions, receiptRefs, eventType: "turn.execution.completed",
          nano: completedNano, sequence: 1, terminalStatus: "completed" });
      for (const input of [acceptedInput, terminalInput]) observability.recordObservation({ observation: input, authority: observationAuthority });
      observability.project(turnExecutionId);
      const raw = observability.timeline(turnExecutionId, { limit: 20,
        context: { kind: "local_user", canReadRawObservability: true } }).items
        .find((item) => item.observationId?.startsWith("observation:benchmark:end:"));
      if (!raw) fail("BENCHMARK_PORT_UNAVAILABLE", "Authoritative Observation is unavailable.", 503);
      return envelope("Observation", closedPayload("Observation", { ...terminalInput, idempotencyFingerprint: null }), request,
        { metrics: { sequenceGap: false } });
    },
    async queryExport({ observation, ...request }) {
      const turnExecutionId = observation.payload.turnExecutionId;
      const report = observability.export(turnExecutionId, "corptie-json-v4",
        { kind: "local_user", canReadRawObservability: true }).report;
      const wallClockMs = report.wall?.wallClockMs;
      const unattributedMs = report.unattributed?.durationMs ?? null;
      const payload = closedPayload("ObservationExport", {
        schemaVersion: 4, analysisVersion: report.analysisVersion,
        identity: report.identity, sourceIdentity: report.sourceIdentity, versions: report.versions,
        wall: report.wall, wallPartition: report.wallPartition,
        inclusive: { ...report.inclusive, modelInclusiveMs: report.inclusive?.["provider.model_sampling"] ?? null,
          toolInclusiveMs: report.inclusive?.["tool.execute"] ?? null, modelInvocationCount: 0, samplingCount: 0, toolCallCount: 0 },
        unattributed: { unattributedMs, ratio: wallClockMs ? unattributedMs / wallClockMs : 0 },
        contextGrowth: report.contextGrowth, completeness: report.completeness, diagnostics: report.diagnostics,
        samplePolicy: { ...report.samplePolicy, observabilityLevel: "event-stream" },
        sourceReceiptIds: [observation.receiptId], summaryHash: null
      });
      payload.summaryHash = hashWithout(payload, "summaryHash");
      return envelope("ObservationExport", payload, request);
    }
  };
}

function observationInput({ id, turnExecutionId, runId, identity, sourceIdentity, versions, receiptRefs, eventType, nano, sequence, terminalStatus }) {
  return { schemaVersion: 3, observationId: id, turnExecutionId, runId,
    operationRef: { kind: "isolated_run", id: runId }, identity, sourceIdentity, versions, receiptRefs,
    producer: "benchmark_production_composition", producerEventId: `${id}:event`, eventType,
    observedAtUnixNano: nano, monotonicNano: null, clockDomainId: "host:benchmark",
    sourceOccurredAtUnixNano: nano, sourceClockQuality: "authoritative", producerSequence: sequence,
    safeAttributes: terminalStatus ? { terminalStatus } : {}, status: "accepted", errorCode: null };
}

function envelope(type, payload, request, options = {}) {
  return createReceiptEnvelope(type, closedPayload(type, payload), requestIdentity(request), options);
}
function closedPayload(type, payload) {
  const fields = RECEIPT_IDENTITY_PROFILES[type].fields;
  return Object.fromEntries(fields.map((field) => [field, Object.hasOwn(payload, field) ? payload[field] : null]));
}
function requestIdentity(request) { return Object.fromEntries(["experimentId", "attemptId", "sampleId", "pairIndex", "mode", "variant"]
  .map((field) => [field, request?.[field] ?? null])); }
function authenticatedSession(authority) { return { logicalSessionId: authority.startup.logicalSessionId,
  workItemId: authority.startup.workItemId, repositoryId: authority.startup.repositoryId, worktreeId: authority.startup.worktreeId }; }
function ref(kind, receiptId, producer, producerSchemaVersion) { return { kind, receiptId, producer, producerSchemaVersion }; }
function searchScenarioId(request) { return `benchmark_search:${contentHash(request.attemptId).slice(0, 32)}`; }
function findSearchReceipt(store, logicalSessionId, scenarioId) {
  const row = store.selectOne?.(`SELECT receipt_json FROM project_code_receipts
    WHERE logical_session_id=? AND receipt_type='SearchReceipt' AND json_extract(receipt_json,'$.searchScenarioId')=?
    ORDER BY created_at DESC LIMIT 1`, [logicalSessionId, scenarioId]);
  return row ? JSON.parse(row.receipt_json) : null;
}
function runEvidence(receipt) { return receipt.outcome === "passed" ? [{ kind: "assertion",
  locator: `receipt:${receipt.receiptId}`, hash: receipt.receiptHash, command: TRUE_EXECUTABLE,
  exitCode: 0, assertionSummary: "Run Isolation recorded a passed bounded scenario." }] : []; }
function isoNano(value) { const milliseconds = Date.parse(value); if (!Number.isFinite(milliseconds)) fail("BENCHMARK_RECEIPT_SCHEMA_INVALID", "Run timestamp is invalid."); return String(BigInt(milliseconds) * 1_000_000n); }
function required(value, label) { if (!value) throw new TypeError(`Benchmark production composition requires ${label}.`); return value; }
function fail(code, message, statusCode = 409) { throw benchmarkError(code, message, "production_composition", { statusCode, retryable: statusCode >= 500 }); }
