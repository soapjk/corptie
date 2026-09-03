import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CodeTaskObservabilityService } from "../src/observability/codeTaskObservability.mjs";
import { DependencyContractManifest, OBSERVABILITY_DEPENDENCY_PINS } from "../src/observability/dependencyContractManifest.mjs";
import { classifyStructuredProcess, decomposeShellFallback } from "../src/observability/commandClassifier.mjs";
import { handleCodeTaskObservabilityHttpRequest } from "../src/observability/codeTaskObservabilityHttpApi.mjs";
import { ProviderEventIngestionService } from "../src/application/providerEventIngestionService.mjs";

const TEST_ROOT = "/Volumes/T9/.corptie/development/observability-tests";
const BASE_NANO = 1_788_048_000_000_000_000n;
const at = (milliseconds) => String(BASE_NANO + BigInt(milliseconds) * 1_000_000n);

test("DependencyContractManifest fixes every final contract pin and fails closed for a missing or mismatched dependency", () => {
  const resolved = new DependencyContractManifest({ resolveArtifactPin: resolvedArtifactPin });
  assert.equal(resolved.verify().state, "resolved");
  assert.equal(resolved.snapshot().entries.length, 4);
  assert.match(resolved.manifestIdentity, /^dcm1:[a-f0-9]{64}$/);
  assert.equal(resolved.snapshot().entries.every((entry) => entry.acceptanceState === "approved_fixed"), true);
  const forbiddenPins = new Set([
    "artifact:a7098ce5-372f-4f15-9c55-377763c37fd5", "artifact:a4e25781-d3fc-4e84-b268-a8f5deebae73",
    "artifact:d1a6095d-ab89-477f-b115-1609ccd6c71a", "artifact:619de450-ff1f-4506-b06e-24c015317422",
    "artifact:172b9f2e-a2d1-451c-a3e4-d52ba3d95850", "artifact:f665b81c-aeae-496d-9157-a880588e7005",
    "artifact:ce3c7e2f-13a5-4c29-be40-368489fe87ef"
  ]);
  assert.equal(resolved.snapshot().entries.some((entry) => forbiddenPins.has(entry.artifactId)), false);

  const noResolver = new DependencyContractManifest();
  assert.equal(noResolver.verify().state, "required_unresolved");
  assert.throws(() => noResolver.requireResolved(), { code: "DEPENDENCY_CONTRACT_REQUIRED_UNRESOLVED" });

  const missing = new DependencyContractManifest({ entries: OBSERVABILITY_DEPENDENCY_PINS.slice(1) });
  assert.equal(missing.verify().state, "required_unresolved");
  assert.throws(() => missing.requireResolved(), { code: "DEPENDENCY_CONTRACT_REQUIRED_UNRESOLVED" });

  const mismatch = new DependencyContractManifest({
    resolveArtifactPin: (artifactId, version) => ({ artifactId, version, contentHash: "0".repeat(64), acceptanceState: "approved_fixed" })
  });
  assert.equal(mismatch.verify().state, "required_unresolved");
  assert.ok(mismatch.diagnostics.every((item) => item.code === "DEPENDENCY_CONTRACT_PIN_MISMATCH"));

  const unapproved = new DependencyContractManifest({ resolveArtifactPin: (artifactId, version) => {
    const expected = resolvedArtifactPin(artifactId, version);
    return expected ? { ...expected, acceptanceState: "unapproved" } : null;
  } });
  assert.equal(unapproved.verify().state, "required_unresolved");
});

test("production Provider ingestion persists queryable lifecycle and Tool spans from authoritative receipts", async () => {
  const f = await fixture({ suffix: "production-entry" });
  const startup = f.authority.startupBindingReceipt;
  const binding = { bindingId: startup.providerBindingId, providerId: "provider:test", providerSessionId: "provider-session:one",
    logicalSessionId: startup.logicalSessionId, routingVersion: 9, sessionId: "legacy-session:one", worktreeId: startup.worktreeId,
    providerMetadata: { startupBindingReceipt: startup } };
  f.store.upsertSession({ id: binding.sessionId, title: "Observed", agent: "Agent", provider: binding.providerId, status: "running" });
  const ingest = new ProviderEventIngestionService({ store: f.store, resolveBinding: () => binding,
    project: ({ event, store }) => {
      if (!event.turnId) return { surface: false, outbox: [] };
      store.upsertSessionTurn({ sessionId: binding.sessionId, bindingId: binding.bindingId,
        routingVersion: binding.routingVersion, turnId: event.turnId,
        executionStatus: event.type === "turn.completed" ? "completed" : "running",
        startedAt: event.type === "turn.started" ? event.occurredAt : null,
        endedAt: event.type === "turn.completed" ? event.occurredAt : null, providerSequence: event.providerSequence,
        updatedAt: event.receivedAt });
      return { surface: false, outbox: [] };
    }, observe: (context) => f.service.ingestProviderEvent(context) });
  const base = { schemaVersion: 1, providerId: binding.providerId, providerSessionId: binding.providerSessionId,
    bindingId: binding.bindingId, logicalSessionId: binding.logicalSessionId, routingVersion: binding.routingVersion,
    turnId: startupTurnId(startup), receivedAt: "2026-08-30T04:00:00.000Z", payload: { providerCapabilityClass: "event_stream" } };
  try {
    const events = [
      { providerEventId: "production:start", providerSequence: 1, type: "turn.started", occurredAt: "2026-08-30T04:00:00.000Z" },
      { providerEventId: "production:model-start", providerSequence: 2, itemId: "message:one", type: "assistant.message.started", occurredAt: "2026-08-30T04:00:00.010Z" },
      { providerEventId: "production:tool-start", providerSequence: 3, itemId: "tool-call:one", type: "tool.started", occurredAt: "2026-08-30T04:00:00.020Z" },
      { providerEventId: "production:tool-end", providerSequence: 4, itemId: "tool-call:one", type: "tool.completed", occurredAt: "2026-08-30T04:00:00.070Z" },
      { providerEventId: "production:model-end", providerSequence: 5, itemId: "message:one", type: "assistant.message.completed", occurredAt: "2026-08-30T04:00:00.090Z" },
      { providerEventId: "production:end", providerSequence: 6, type: "turn.completed", occurredAt: "2026-08-30T04:00:00.100Z" }
    ];
    let result;
    for (const event of events) result = ingest.ingest({ ...base, ...event });
    assert.equal(result.status, "applied");
    assert.equal(result.observability.state, "accepted");
    assert.equal(result.observability.report.wall.wallClockMs, 100);
    assert.equal(result.observability.report.wallPartition.attributedUnionMs, 80);
    assert.equal(result.observability.report.wallPartition.unattributedMs, 20);
    assert.equal(result.observability.report.wallPartition.overlapMs, 50);
    assert.equal(result.observability.report.inclusive["tool.execute"], 50);
    assert.equal(result.observability.report.inclusive["provider.model_sampling"], 80);
    assert.equal(result.observability.report.completeness.state, "complete");
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM observation_correlation_index").count, 6);
    assert.equal(f.service.executions(startup.logicalSessionId, startupTurnId(startup), localUser()).length, 1);
    const correlation = f.service.correlations(result.observability.report.identity.turnExecutionId, localUser()).items;
    assert.equal(correlation.filter((item) => item.operationRef?.kind === "tool_call").length, 2);
    assert.equal(correlation.every((item) => item.runId == null), true);
    const httpResponse = mockResponse();
    const summaryUrl = new URL(`http://127.0.0.1/turn-executions/${encodeURIComponent(result.observability.report.identity.turnExecutionId)}/summary`);
    assert.equal(handleCodeTaskObservabilityHttpRequest({ request: { method: "GET", headers: {} },
      response: httpResponse, url: summaryUrl, service: f.service }), true);
    assert.equal(httpResponse.status, 200);
    const httpSummary = JSON.parse(httpResponse.body).summary;
    assert.equal(httpSummary.identity.turnExecutionId, result.observability.report.identity.turnExecutionId);
    assert.equal(httpSummary.inclusive["tool.execute"], 50);
    assert.equal(f.store.selectOne("SELECT finalized FROM observation_turn_summaries WHERE turn_execution_id = ?",
      [result.observability.report.identity.turnExecutionId]).finalized, 1);

    const brokenTurn = { ...base, turnId: "turn:broken" };
    ingest.ingest({ ...brokenTurn, providerEventId: "broken:start", providerSequence: 7,
      type: "turn.started", occurredAt: "2026-08-30T04:00:01.000Z" });
    const skipped = ingest.ingest({ ...base, turnId: null, providerEventId: "broken:uncaptured", providerSequence: 8,
      type: "provider.connection.changed", occurredAt: "2026-08-30T04:00:01.010Z" });
    assert.deepEqual(skipped.observability, { state: "skipped", reason: "event_without_turn" });
    ingest.ingest({ ...brokenTurn, providerEventId: "broken:tool-start", providerSequence: 9, itemId: "tool-call:broken",
      type: "tool.started", occurredAt: "2026-08-30T04:00:01.020Z" });
    const brokenResult = ingest.ingest({ ...brokenTurn, providerEventId: "broken:end", providerSequence: 10,
      type: "turn.completed", occurredAt: "2026-08-30T04:00:00.900Z" });
    const diagnosticCodes = brokenResult.observability.report.diagnostics.map((item) => item.code);
    assert.ok(diagnosticCodes.includes("DROPPED_EVENT"));
    assert.ok(diagnosticCodes.includes("CLOCK_SKEW"));
    assert.ok(diagnosticCodes.includes("MISSING_TERMINAL_EVENT"));
  } finally { await f.close(); }
});

test("legacy cutover is proof-gated, atomic on failure, audited, and idempotent", async () => {
  const failed = await fixture({ suffix: "cutover-failure", beforeLegacyCutover: () => { throw new Error("injected cutover failure"); } });
  try {
    failed.store.db.run("CREATE TABLE turn_trace_runs (id TEXT)");
    failed.store.db.run("CREATE TABLE turn_time_summaries (id TEXT)");
    assert.throws(() => failed.service.finalizeLegacyCutover(failed.turnExecutionId), { code: "OBSERVATION_CUTOVER_PROOF_REQUIRED" });
    for (const item of [
      observation(failed, "failed-cutover-start", 0, "turn.execution.accepted", {}, { producerSequence: 0 }),
      observation(failed, "failed-cutover-end", 1, "turn.execution.completed", {}, { producerSequence: 1 })
    ]) {
      item.producer = "provider_event_ingestion";
      failed.service.recordObservation({ observation: item, authority: failed.authority });
    }
    failed.service.project(failed.turnExecutionId);
    assert.throws(() => failed.service.finalizeLegacyCutover(failed.turnExecutionId), /injected cutover failure/);
    assert.ok(failed.store.selectOne("SELECT name FROM sqlite_master WHERE type='table' AND name='turn_trace_runs'"));
    assert.equal(failed.store.selectOne("SELECT state FROM observation_schema_migrations").state, "ready");
  } finally { await failed.close(); }

  const f = await fixture({ suffix: "cutover-success" });
  try {
    f.store.db.run("CREATE TABLE turn_trace_runs (id TEXT)");
    f.store.db.run("CREATE TABLE turn_time_summaries (id TEXT)");
    const production = observation(f, "cutover-start", 0, "turn.execution.accepted", {}, { producerSequence: 0 });
    production.producer = "provider_event_ingestion";
    f.service.recordObservation({ observation: production, authority: f.authority });
    const terminal = observation(f, "cutover-end", 1, "turn.execution.completed", {}, { producerSequence: 1 });
    terminal.producer = "provider_event_ingestion";
    f.service.recordObservation({ observation: terminal, authority: f.authority });
    f.service.project(f.turnExecutionId);
    const cutover = f.service.finalizeLegacyCutover(f.turnExecutionId);
    assert.deepEqual(cutover, { state: "completed", idempotentReplay: false });
    assert.equal(f.store.selectOne("SELECT name FROM sqlite_master WHERE type='table' AND name='turn_trace_runs'"), null);
    assert.equal(f.store.selectOne("SELECT event FROM observation_migration_audit WHERE event='legacy_cutover_completed'").event, "legacy_cutover_completed");
    assert.deepEqual(f.service.finalizeLegacyCutover(f.turnExecutionId), { state: "completed", idempotentReplay: true });
  } finally { await f.close(); }
});

test("wall partition uses interval union, closes exactly, and diagnoses legal overlap without double counting", async () => {
  const f = await fixture();
  try {
    const events = [
      observation(f, "accepted", 0, "turn.execution.accepted", {}, { producerSequence: 0 }),
      observation(f, "test-start", 0, "interval.started", spanAttributes("test", "process.test"), { producerSequence: 1, operationRef: operation("operation:test") }),
      observation(f, "build-start", 20, "interval.started", spanAttributes("build", "process.build"), { producerSequence: 2, operationRef: operation("operation:build") }),
      observation(f, "test-end", 70, "interval.completed", spanAttributes("test", "process.test"), { producerSequence: 3, operationRef: operation("operation:test") }),
      observation(f, "build-end", 90, "interval.completed", spanAttributes("build", "process.build"), { producerSequence: 4, operationRef: operation("operation:build") }),
      observation(f, "terminal", 100, "turn.execution.completed", {}, { producerSequence: 5 })
    ];
    events.forEach((item) => assert.equal(f.service.recordObservation({ observation: item, authority: f.authority }).state, "accepted"));
    const report = f.service.project(f.turnExecutionId);
    assert.equal(report.wall.wallClockMs, 100);
    assert.equal(report.wallPartition.attributedUnionMs, 90);
    assert.equal(report.wallPartition.unattributedMs, 10);
    assert.equal(report.wallPartition.overlapMs, 50);
    assert.equal(report.unattributed.gapIntervals.length, 1);
    assert.equal(report.wall.wallClockMs, report.wallPartition.attributedUnionMs + report.wallPartition.unattributedMs);
    assert.equal(report.inclusive["process.test"], 70);
    assert.equal(report.inclusive["process.build"], 70);
    assert.ok(report.diagnostics.some((item) => item.code === "INTERVAL_OVERLAP" && item.legalParallel));
    assert.equal(report.completeness.state, "complete");
  } finally { await f.close(); }
});

test("missing terminal, producer drops, clock skew, orphan terminal and recovery attempts remain diagnosable", async () => {
  const f = await fixture();
  try {
    const attemptOne = { ...f.authority, turnExecutionReceipt: { ...f.authority.turnExecutionReceipt, turnExecutionId: f.turnExecutionId } };
    f.service.recordObservation({ observation: observation(f, "accepted", 0, "turn.execution.accepted", {}, { producerSequence: 0 }), authority: attemptOne });
    f.service.recordObservation({ observation: observation(f, "skew-start", 10, "interval.started",
      { ...spanAttributes("skew", "process.test"), attempt: 1, retryGroupId: "retry:one" },
      { producerSequence: 2, monotonicNano: "20", operationRef: operation("operation:skew") }), authority: attemptOne });
    f.service.recordObservation({ observation: observation(f, "skew-end", 20, "interval.completed",
      { ...spanAttributes("skew", "process.test"), attempt: 1, retryGroupId: "retry:one" },
      { producerSequence: 3, monotonicNano: "10", operationRef: operation("operation:skew") }), authority: attemptOne });
    f.service.recordObservation({ observation: observation(f, "orphan", 30, "interval.failed", spanAttributes("orphan", "process.build"),
      { producerSequence: 4, operationRef: operation("operation:orphan") }), authority: attemptOne });
    const partial = f.service.project(f.turnExecutionId);
    for (const code of ["MISSING_TERMINAL_EVENT", "DROPPED_EVENT", "CLOCK_SKEW", "ORPHAN_TERMINAL"]) {
      assert.ok(partial.diagnostics.some((item) => item.code === code), `${code} diagnostic`);
    }
    assert.equal(partial.wall.finalized, false);
    assert.equal(partial.wall.wallClockMs, null);

    const recoveredId = "turn_execution:recovered";
    const recoveredAuthority = authority({ turnExecutionId: recoveredId });
    const recoveredFixture = { ...f, authority: recoveredAuthority, turnExecutionId: recoveredId };
    f.service.recordObservation({ observation: observation(recoveredFixture, "accepted-r", 40, "turn.execution.accepted", {}, { producerSequence: 0 }), authority: recoveredAuthority });
    f.service.recordObservation({ observation: observation(recoveredFixture, "terminal-r", 50, "turn.execution.cancelled", {}, { producerSequence: 1 }), authority: recoveredAuthority });
    const executions = f.service.executions(f.identity.logicalSessionId, f.identity.turnId, localUser());
    assert.deepEqual(executions.map((item) => item.turnExecutionId), [f.turnExecutionId, recoveredId]);
  } finally { await f.close(); }
});

test("ordinary Tool/MCP/Artifact correlations never acquire runId and isolated runs require the exact Run receipt", async () => {
  const f = await fixture();
  try {
    const ordinary = observation(f, "ordinary", 1, "tool.receipt", {}, { producerSequence: 0,
      operationRef: { kind: "tool_call", id: "tool_call:one" } });
    assert.equal(f.service.recordObservation({ observation: ordinary, authority: f.authority }).state, "accepted");
    const correlation = f.service.correlations(f.turnExecutionId, localUser()).items[0];
    assert.equal(correlation.runId, null);
    assert.deepEqual(correlation.operationRef, { kind: "tool_call", id: "tool_call:one" });

    const invalid = observation({ ...f, turnExecutionId: "turn_execution:bad-run",
      authority: authority({ turnExecutionId: "turn_execution:bad-run" }) }, "bad-run", 2, "interval.started", spanAttributes("bad", "process.test"), {
      producerSequence: 0, runId: "run:one", operationRef: { kind: "isolated_run", id: "run:one" }
    });
    assert.throws(() => f.service.recordObservation({ observation: invalid,
      authority: authority({ turnExecutionId: "turn_execution:bad-run" }) }), { code: "RUN_ISOLATION_RECEIPT_REQUIRED" });

    const isolatedAuthority = authority({ turnExecutionId: "turn_execution:isolated", runId: "run:one" });
    const isolatedFixture = { ...f, turnExecutionId: "turn_execution:isolated", authority: isolatedAuthority };
    const isolated = observation(isolatedFixture, "isolated", 3, "interval.started", spanAttributes("isolated", "process.test"), {
      producerSequence: 0, runId: "run:one", operationRef: { kind: "isolated_run", id: "run:one" },
      receiptRefs: [...receiptRefs("turn_execution:isolated"), receiptRef("run_isolation", "receipt:run")]
    });
    assert.equal(f.service.recordObservation({ observation: isolated, authority: isolatedAuthority }).state, "accepted");
  } finally { await f.close(); }
});

test("RunReceipt v6 and ToolsetValidationReceipt v3 are dereferenced from authoritative stores and legacy or drifted receipts fail closed", async () => {
  const f = await fixture({ suffix: "receipt-v6" });
  try {
    const turnExecutionId = "turn_execution:receipt-v6";
    const valid = authority({ turnExecutionId, source: true });
    valid.toolsetValidationReceipt = toolsetReceipt(valid.repositorySourceSnapshotReceipt);
    valid.runIsolationReceipt = runReceipt({ runId: "run:receipt-v6", snapshot: valid.repositorySourceSnapshotReceipt,
      toolset: valid.toolsetValidationReceipt });
    const isolatedFixture = { ...f, turnExecutionId, authority: valid, identity: valid.identity };
    const item = observation(isolatedFixture, "receipt-v6", 1, "interval.started", spanAttributes("receipt-v6", "process.test"), {
      producerSequence: 0, runId: valid.runIsolationReceipt.runId,
      operationRef: { kind: "isolated_run", id: valid.runIsolationReceipt.runId },
      sourceIdentity: { sourceCommitOid: "commit:one", sourceTreeOid: "tree:one", snapshotReceiptId: valid.repositorySourceSnapshotReceipt.receiptId },
      versions: { sourceFingerprint: valid.repositorySourceSnapshotReceipt.sourceFingerprint,
        toolsetVersion: valid.toolsetValidationReceipt.toolsetVersion },
      receiptRefs: [...receiptRefs(turnExecutionId),
        receiptRef("repository_source_snapshot", valid.repositorySourceSnapshotReceipt.receiptId),
        receiptRef("toolset_validation", valid.toolsetValidationReceipt.receiptId, 3),
        receiptRef("run_isolation", valid.runIsolationReceipt.receiptId, 6)]
    });
    assert.equal(f.service.recordObservation({ observation: item, authority: valid }).state, "accepted");

    for (const schemaVersion of [4, 5]) {
      const legacy = { ...valid, runIsolationReceipt: { ...valid.runIsolationReceipt, schemaVersion } };
      assert.throws(() => f.service.recordObservation({ observation: { ...item,
        observationId: `observation:run-v${schemaVersion}`, producerEventId: `event:run-v${schemaVersion}` }, authority: legacy }),
      { code: "RUN_ISOLATION_RECEIPT_REQUIRED" });
    }

    const toolsetV2 = { ...valid, toolsetValidationReceipt: { ...valid.toolsetValidationReceipt, schemaVersion: 2 } };
    assert.throws(() => f.service.recordObservation({ observation: { ...item,
      observationId: "observation:toolset-v2", producerEventId: "event:toolset-v2" }, authority: toolsetV2 }),
    { code: "RUN_TOOLSET_RECEIPT_UNRESOLVED" });

    const hashDrift = { ...valid, runIsolationReceipt: { ...valid.runIsolationReceipt, receiptHash: "0".repeat(64) } };
    assert.throws(() => f.service.recordObservation({ observation: { ...item,
      observationId: "observation:run-hash-drift", producerEventId: "event:run-hash-drift" }, authority: hashDrift }),
    { code: "RUN_ISOLATION_RECEIPT_HASH_MISMATCH" });

    const oldPinToolset = withReceiptHash({ ...valid.toolsetValidationReceipt,
      artifactRef: { ...valid.toolsetValidationReceipt.artifactRef,
        artifactId: "artifact:f665b81c-aeae-496d-9157-a880588e7005",
        contentHash: "b54ce2c5d36d2d5b31aa024b1c2ad40267fd1650b67a9545b6fc6062fac70df5" } });
    const oldPinPointer = { ...valid.runIsolationReceipt.toolsetValidationReceiptPointer,
      receiptHash: oldPinToolset.receiptHash };
    const oldPinReceipt = withReceiptHash({ ...valid.runIsolationReceipt,
      toolsetValidationReceiptPointer: oldPinPointer });
    assert.throws(() => f.service.recordObservation({ observation: { ...item,
      observationId: "observation:old-pin", producerEventId: "event:old-pin" },
    authority: { ...valid, runIsolationReceipt: oldPinReceipt, toolsetValidationReceipt: oldPinToolset } }),
    { code: "DEPENDENCY_CONTRACT_RECEIPT_ARTIFACT_MISMATCH" });

    const sourceDriftReceipt = withReceiptHash({ ...valid.runIsolationReceipt, sourceFingerprint: "e".repeat(64) });
    assert.throws(() => f.service.recordObservation({ observation: { ...item,
      observationId: "observation:source-drift", producerEventId: "event:source-drift" },
    authority: { ...valid, runIsolationReceipt: sourceDriftReceipt } }),
    { code: "RUN_SOURCE_FINGERPRINT_MISMATCH" });
  } finally { await f.close(); }
});

test("identity and version aliases are copied one-to-one from receipts; source contracts reject unresolved or mismatched chains", async () => {
  const f = await fixture();
  try {
    const host = { receiptId: "receipt:host", requestedVersion: "requested:2", appliedVersion: "applied:2",
      appliedCatalogVersion: "catalog:2", providerCapabilityRevision: "capability:2" };
    const hostAuthority = { ...f.authority, toolHostAppliedReceipt: host };
    const item = observation(f, "context", 1, "context.metrics", {
      staticSystemBytes: 100, artifactIndexBytes: 20, materializedToolCount: 4, toolSchemaBytes: 80,
      repeatedDeliverySurfaceCount: 1, toolSearchCount: 2, toolLoadCount: 1, inputTokens: 50,
      cachedInputTokens: 10, metricCompleteness: "complete", prompt: "must be dropped"
    }, { producerSequence: 0, receiptRefs: [...receiptRefs(), receiptRef("tool_host_applied", host.receiptId)],
      versions: { catalogVersion: "catalog:2", desiredMaterializationVersion: "requested:2",
        appliedMaterializationVersion: "applied:2", providerCapabilityRevision: "capability:2" } });
    const receipt = f.service.recordObservation({ observation: item, authority: hostAuthority });
    assert.equal(receipt.droppedAttributeCount, 1);
    const report = f.service.project(f.turnExecutionId);
    assert.equal(report.contextGrowth.contextBytes, 120);
    assert.equal(report.contextGrowth.toolSchemaBytes, 80);
    assert.equal(report.contextGrowth.inputTokens, 50);

    const mismatch = observation({ ...f, turnExecutionId: "turn_execution:catalog-mismatch",
      authority: authority({ turnExecutionId: "turn_execution:catalog-mismatch" }) }, "mismatch", 2, "context.metrics", {}, {
      producerSequence: 0, receiptRefs: [...receiptRefs("turn_execution:catalog-mismatch"), receiptRef("tool_host_applied", host.receiptId)],
      versions: { catalogVersion: "wrong" }
    });
    assert.throws(() => f.service.recordObservation({ observation: mismatch,
      authority: { ...authority({ turnExecutionId: "turn_execution:catalog-mismatch" }), toolHostAppliedReceipt: host } }),
    { code: "CATALOG_VERSION_MISMATCH" });

    const sourceExecutionId = "turn_execution:source-valid";
    const sourceAuthority = authority({ turnExecutionId: sourceExecutionId, source: true });
    sourceAuthority.searchReceipt = searchReceipt(sourceAuthority);
    const sourceFixture = { ...f, authority: sourceAuthority, turnExecutionId: sourceExecutionId };
    const sourceValid = observation(sourceFixture, "source-valid", 2, "source.snapshot", {}, { producerSequence: 0,
      receiptRefs: [...receiptRefs(sourceExecutionId), receiptRef("repository_source_snapshot", "receipt:snapshot")],
      sourceIdentity: { sourceCommitOid: "commit:one", sourceTreeOid: "tree:one", snapshotReceiptId: "receipt:snapshot" },
      versions: { sourceFingerprint: "f".repeat(64) } });
    assert.equal(f.service.recordObservation({ observation: sourceValid, authority: sourceAuthority }).state, "accepted");
    const sourceMismatch = { ...sourceValid, observationId: "observation:source-mismatch", producerEventId: "event:source-mismatch",
      versions: { sourceFingerprint: "e".repeat(64) } };
    assert.throws(() => f.service.recordObservation({ observation: sourceMismatch, authority: sourceAuthority }),
      { code: "SOURCE_SNAPSHOT_REFERENCE_MISMATCH" });

    const unresolved = await fixture({ resolveArtifactPin: () => null });
    try {
      const snapshotAuthority = authority({ turnExecutionId: unresolved.turnExecutionId, source: true });
      const source = observation(unresolved, "source", 3, "source.snapshot", {}, { producerSequence: 0,
        receiptRefs: [...receiptRefs(), receiptRef("repository_source_snapshot", "receipt:snapshot")],
        sourceIdentity: { sourceCommitOid: "commit:one", sourceTreeOid: "tree:one", snapshotReceiptId: "snapshot:one" },
        versions: { sourceFingerprint: "f".repeat(64) } });
      assert.throws(() => unresolved.service.recordObservation({ observation: source, authority: snapshotAuthority }),
        { code: "DEPENDENCY_CONTRACT_REQUIRED_UNRESOLVED" });
    } finally { await unresolved.close(); }
  } finally { await f.close(); }
});

test("raw observations stay in restricted external dataRoot with quota, redaction, idempotency, TTL cleanup, and no raw main-Store column", async () => {
  let clock = new Date("2026-08-30T00:00:00.000Z");
  const f = await fixture({ now: () => clock, rawTtlDays: 1 });
  try {
    const item = observation(f, "raw", 0, "turn.execution.accepted", { output: "secret", errorCode: "SAFE" }, { producerSequence: 0 });
    assert.equal(f.service.recordObservation({ observation: item, authority: f.authority }).state, "accepted");
    assert.equal(f.service.recordObservation({ observation: item, authority: f.authority }).state, "duplicate");
    assert.throws(() => f.service.recordObservation({ observation: { ...item, producerEventId: "changed" }, authority: f.authority }),
      { code: "OBSERVATION_ID_CONFLICT" });
    f.service.flush();
    const schemas = f.store.selectAll("SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE 'observation_%'").map((row) => row.sql).join("\n");
    assert.equal(/raw_trace_json|stdout|stderr|prompt/i.test(schemas), false);
    const manifest = JSON.parse(f.store.selectOne("SELECT raw_manifest_json FROM observation_turn_executions").raw_manifest_json);
    const rawPath = join(f.dataRoot, "observability", "test", "raw", manifest.objectId);
    const raw = await readFile(rawPath, "utf8");
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("SAFE"), true);
    clock = new Date("2026-09-02T00:00:00.000Z");
    assert.equal(f.service.cleanup().raw.deleted, 1);
  } finally { await f.close(); }

  const quota = await fixture({ quotaBytes: 64 });
  try {
    const result = quota.service.recordObservation({ observation: observation(quota, "quota", 0, "turn.execution.accepted", {}, { producerSequence: 0 }), authority: quota.authority });
    assert.equal(result.state, "quarantined");
    assert.equal(result.rawCaptureStatus, "quota");
  } finally { await quota.close(); }
});

test("structured command facts win, compound fallback preserves every segment, retry/cancel semantics, and unsafe shell is not parsed", () => {
  assert.equal(classifyStructuredProcess({ receiptClass: "test", executable: "anything" }).classificationSource, "run_isolation_receipt");
  assert.equal(classifyStructuredProcess({ executable: "/usr/bin/swift", argumentKinds: ["test"] }).intervalClass, "test");
  const compound = decomposeShellFallback("rg TODO apps && swift test | tee result ; git status");
  assert.equal(compound.parseStatus, "parsed");
  assert.deepEqual(compound.operationSet, ["search", "test", "unknown", "version_control"]);
  assert.equal(compound.segments.length, 4);
  assert.equal(decomposeShellFallback("echo $(printenv SECRET)").parseStatus, "unsafe");
});

test("Provider capability classes share the same identity contract and opaque coverage is distinct from true unattributed gaps", async () => {
  for (const providerCapabilityClass of ["codex", "claude", "openclacky", "opaque"]) {
    const f = await fixture({ suffix: providerCapabilityClass });
    try {
      f.service.recordObservation({ observation: observation(f, "accepted", 0, "turn.execution.accepted", {}, { producerSequence: 0 }), authority: f.authority });
      f.service.recordObservation({ observation: observation(f, "provider-start", 10, "interval.started",
        { ...spanAttributes("provider", providerCapabilityClass === "opaque" ? "provider.opaque" : "provider.model_sampling"), providerCapabilityClass },
        { producerSequence: 1, operationRef: operation("operation:provider") }), authority: f.authority });
      f.service.recordObservation({ observation: observation(f, "provider-end", 90, "interval.completed", spanAttributes("provider", "provider.model_sampling"),
        { producerSequence: 2, operationRef: operation("operation:provider") }), authority: f.authority });
      f.service.recordObservation({ observation: observation(f, "terminal", 100, "turn.execution.completed", {}, { producerSequence: 3 }), authority: f.authority });
      const report = f.service.project(f.turnExecutionId);
      assert.equal(report.wallPartition.unattributedMs, 20);
      assert.equal(report.inclusive[providerCapabilityClass === "opaque" ? "provider.opaque" : "provider.model_sampling"], 80);
      assert.equal(report.identity.providerBindingId, f.identity.providerBindingId);
    } finally { await f.close(); }
  }
});

test("summary/timeline API enforces scope and raw permissions, paginates stably, exports provider-neutral JSON and OTLP, and meets local read budget", async () => {
  const f = await fixture();
  try {
    for (const item of [
      observation(f, "accepted", 0, "turn.execution.accepted", {}, { producerSequence: 0 }),
      observation(f, "start", 0, "interval.started", spanAttributes("one", "process.test"), { producerSequence: 1, operationRef: operation("operation:one") }),
      observation(f, "end", 100, "interval.completed", spanAttributes("one", "process.test"), { producerSequence: 2, operationRef: operation("operation:one") }),
      observation(f, "terminal", 100, "turn.execution.completed", {}, { producerSequence: 3 })
    ]) f.service.recordObservation({ observation: item, authority: f.authority });
    f.service.project(f.turnExecutionId);
    assert.throws(() => f.service.summary(f.turnExecutionId, { kind: "session", logicalSessionId: "session:other" }),
      { code: "OBSERVATION_PERMISSION_DENIED" });
    assert.throws(() => f.service.timeline(f.turnExecutionId, { context: { kind: "session", logicalSessionId: f.identity.logicalSessionId } }),
      { code: "OBSERVATION_RAW_PERMISSION_DENIED" });
    const page = f.service.timeline(f.turnExecutionId, { limit: 2, context: { kind: "session", logicalSessionId: f.identity.logicalSessionId, canReadRawObservability: true } });
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    const next = f.service.timeline(f.turnExecutionId, { cursor: page.nextCursor, limit: 20, context: localUser() });
    assert.notEqual(next.items[0].observationId ?? next.items[0].spanId, page.items[0].observationId ?? page.items[0].spanId);
    assert.equal(f.service.export(f.turnExecutionId, "corptie-json-v4", localUser()).format, "corptie-json-v4");
    assert.equal(f.service.export(f.turnExecutionId, "otlp", localUser()).resourceSpans[0].scopeSpans[0].spans.length, 1);

    const response = mockResponse();
    const request = { method: "GET", headers: {} };
    const url = new URL(`http://localhost/turn-executions/${encodeURIComponent(f.turnExecutionId)}/summary`);
    assert.equal(handleCodeTaskObservabilityHttpRequest({ request, response, url, service: f.service }), true);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).summary.identity.turnExecutionId, f.turnExecutionId);
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) f.service.summary(f.turnExecutionId, localUser());
    assert.ok((performance.now() - started) / 100 < 100);
  } finally { await f.close(); }
});

test("critical enqueue overhead stays below 5ms p99 under local external-storage load", async () => {
  const f = await fixture();
  try {
    const samples = [];
    for (let index = 0; index < 300; index += 1) {
      const started = performance.now();
      f.service.recordObservation({ observation: observation(f, `perf-${index}`, index, "progress", {}, { producerSequence: index }), authority: f.authority });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    assert.ok(p99 < 5, `critical enqueue p99 ${p99.toFixed(3)}ms`);
  } finally { await f.close(); }
});

test("10,000-span Timeline first page remains bounded and compact Summary never embeds the full raw projection", async () => {
  const f = await fixture({ suffix: "ten-thousand" });
  try {
    f.service.recordObservation({ observation: observation(f, "accepted", 0, "turn.execution.accepted", {}, { producerSequence: 0 }), authority: f.authority });
    const lines = [];
    for (let index = 0; index < 10_000; index += 1) {
      const start = observation(f, `s-${index}`, 1, "interval.started", spanAttributes(`span-${index}`, "process.test"), {
        producerSequence: index * 2 + 1, operationRef: operation(`operation:${index}`)
      });
      const end = observation(f, `e-${index}`, 2, "interval.completed", spanAttributes(`span-${index}`, "process.test"), {
        producerSequence: index * 2 + 2, operationRef: operation(`operation:${index}`)
      });
      start.observedAtUnixNano = String(BASE_NANO + 1_000_000n + BigInt(index) * 10_000n);
      end.observedAtUnixNano = String(BASE_NANO + 1_005_000n + BigInt(index) * 10_000n);
      start.monotonicNano = String(1_000_000n + BigInt(index) * 10_000n);
      end.monotonicNano = String(1_005_000n + BigInt(index) * 10_000n);
      lines.push(`${JSON.stringify(start)}\n`, `${JSON.stringify(end)}\n`);
    }
    const objectId = `${createHash("sha256").update(f.turnExecutionId).digest("hex")}.ndjson`;
    await appendFile(join(f.dataRoot, "observability", "test", "raw", objectId), lines.join(""), "utf8");
    f.service.recordObservation({ observation: observation(f, "terminal", 102, "turn.execution.completed", {}, { producerSequence: 20_001 }), authority: f.authority });
    const started = performance.now();
    const page = f.service.timeline(f.turnExecutionId, { limit: 100, context: localUser() });
    const latencyMs = performance.now() - started;
    assert.equal(page.items.length, 100);
    assert.ok(latencyMs < 200, `10k-span Timeline first page ${latencyMs.toFixed(2)}ms`);
    const report = f.service.project(f.turnExecutionId);
    assert.equal(report.spanCount, 10_000);
    assert.ok(report.wallPartition.atomicSegments.length <= 256);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 512 * 1024);
  } finally { await f.close(); }
});

async function fixture(options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TEST_ROOT, `case-${options.suffix ?? "default"}-`));
  const dataRoot = join(directory, "data"); await mkdir(dataRoot, { recursive: true });
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const turnExecutionId = `turn_execution:${options.suffix ?? "one"}`;
  const auth = authority({ turnExecutionId });
  const service = new CodeTaskObservabilityService({ store, environment: "test", dataRootResolver: () => dataRoot,
    resolveArtifactPin: options.resolveArtifactPin ?? resolvedArtifactPin, now: options.now, quotaBytes: options.quotaBytes,
    rawTtlDays: options.rawTtlDays, beforeLegacyCutover: options.beforeLegacyCutover });
  service.initialize();
  return { directory, dataRoot, store, service, authority: auth, identity: auth.identity, turnExecutionId,
    close: async () => { service.flush(); await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

function authority({ turnExecutionId = "turn_execution:one", runId, source = false } = {}) {
  const identity = { workId: "work:one", taskId: "task:one", logicalSessionId: "session:one",
    providerBindingId: "binding:one", bindingGeneration: 2, repositoryId: "repository:one", worktreeId: "worktree:one", turnId: "turn:one" };
  const value = { identity,
    startupBindingReceipt: { schemaVersion: 2, status: "ready", startupOperationId: "startup:one", receiptHash: "a".repeat(64),
      workId: identity.workId, taskId: identity.taskId, logicalSessionId: identity.logicalSessionId,
      providerBindingId: identity.providerBindingId,
      bindingGeneration: identity.bindingGeneration, repositoryId: identity.repositoryId, worktreeId: identity.worktreeId,
      sourceCommitOid: "commit:one", sourceTreeOid: "tree:one" },
    turnExecutionReceipt: { receiptId: `receipt:${turnExecutionId}`, turnExecutionId, turnId: identity.turnId,
      logicalSessionId: identity.logicalSessionId } };
  if (source) value.repositorySourceSnapshotReceipt = sourceSnapshotReceipt();
  if (runId) value.runIsolationReceipt = runReceipt({ runId, snapshot: value.repositorySourceSnapshotReceipt ?? null });
  return value;
}

function sourceSnapshotReceipt() {
  return withReceiptHash({ receiptId: "receipt:snapshot", schemaVersion: 1, resourceVersion: 1,
    artifactRef: contractArtifactRef("search_snapshot_schema", "RepositorySourceSnapshotReceipt", 1),
    sourceFingerprint: "f".repeat(64) });
}

function toolsetReceipt(snapshot = sourceSnapshotReceipt()) {
  return withReceiptHash({ receiptId: "toolset_validation_receipt:one", schemaVersion: 3, resourceVersion: 1,
    artifactRef: contractArtifactRef("toolset_receipt_schema", "ToolsetValidationReceipt", 3),
    snapshotRef: receiptPointer(snapshot, ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion"]),
    toolsetVersion: `ptv1:${"b".repeat(64)}`, validationPlanIdentity: `vp1:${"c".repeat(64)}` });
}

function runReceipt({ runId = "run:one", snapshot = null, toolset = null } = {}) {
  const pointer = toolset ? { ...receiptPointer(toolset,
    ["receiptId", "receiptHash", "resourceVersion", "toolsetVersion", "validationPlanIdentity"]),
    sourceFingerprint: toolset.snapshotRef.sourceFingerprint } : null;
  return withReceiptHash({ receiptId: "receipt:run", schemaVersion: 6, receiptHash: "",
    resourceVersion: 1, runId,
    sourceFingerprint: snapshot?.sourceFingerprint ?? null,
    repositorySourceSnapshotReceiptRef: snapshot
      ? receiptPointer(snapshot, ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion"])
      : null,
    toolsetValidationReceiptPointer: pointer });
}

function searchReceipt(authorityValue) {
  const snapshot = authorityValue.repositorySourceSnapshotReceipt;
  return withReceiptHash({ receiptId: "receipt:search", schemaVersion: 1, resourceVersion: 1,
    artifactRef: contractArtifactRef("search_snapshot_schema", "SearchReceipt", 1),
    snapshotReceiptRef: receiptPointer(snapshot, ["receiptId", "receiptHash", "sourceFingerprint", "schemaVersion", "resourceVersion"]),
    sourceFingerprint: snapshot.sourceFingerprint, toolsetValidationReceiptRef: null,
    runIsolationReceiptRef: null, runId: null });
}

function contractArtifactRef(dependency, receiptType, schemaVersion) {
  const pin = OBSERVABILITY_DEPENDENCY_PINS.find((entry) => entry.dependency === dependency);
  if (!pin) throw new Error(`Missing fixture dependency pin: ${dependency}`);
  return { artifactId: pin.artifactId, version: pin.version, contentHash: pin.contentHash,
    relation: "implementation_spec", receiptType, schemaVersion };
}

function receiptPointer(receipt, fields) { return Object.fromEntries(fields.map((field) => [field, receipt[field]])); }
function withReceiptHash(receipt) {
  const canonical = { ...receipt }; delete canonical.receiptHash;
  return { ...canonical, receiptHash: createHash("sha256").update(stableStringify(canonical)).digest("hex") };
}
function stableStringify(value) { if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; }

function observation(f, id, milliseconds, eventType, safeAttributes, overrides = {}) {
  const executionReceiptId = f.authority.turnExecutionReceipt.receiptId;
  return { schemaVersion: 3, observationId: `observation:${id}`, turnExecutionId: f.turnExecutionId,
    runId: overrides.runId ?? null, operationRef: overrides.operationRef ?? null, identity: f.identity,
    sourceIdentity: overrides.sourceIdentity ?? { sourceCommitOid: "commit:one", sourceTreeOid: "tree:one", snapshotReceiptId: null },
    versions: overrides.versions ?? {}, receiptRefs: overrides.receiptRefs ?? receiptRefs(f.turnExecutionId, executionReceiptId),
    producer: "producer:host", producerEventId: `event:${id}`, eventType, observedAtUnixNano: at(milliseconds),
    monotonicNano: overrides.monotonicNano ?? String(BigInt(milliseconds) * 1_000_000n), clockDomainId: "clock:host",
    sourceOccurredAtUnixNano: null, sourceClockQuality: "authoritative", producerSequence: overrides.producerSequence ?? 0,
    safeAttributes, status: "accepted", errorCode: null };
}

function receiptRefs(turnExecutionId = "turn_execution:one", executionReceiptId = `receipt:${turnExecutionId}`) {
  return [receiptRef("startup_binding", "startup:one", 2), receiptRef("turn_execution", executionReceiptId)];
}
function receiptRef(kind, receiptId, producerSchemaVersion = 1) { return { kind, receiptId, producer: `producer:${kind}`, producerSchemaVersion }; }
function resolvedArtifactPin(artifactId, version) {
  const expected = OBSERVABILITY_DEPENDENCY_PINS.find((entry) => entry.artifactId === artifactId && entry.version === version);
  return expected ? { ...expected } : null;
}
function startupTurnId(startup) { return startup.logicalSessionId === "session:one" ? "turn:one" : "turn:production"; }
function spanAttributes(spanKey, intervalClass) { return { spanKey, intervalClass, operation: intervalClass,
  operationSet: [intervalClass], classificationSource: "structured_receipt", classificationConfidence: "high", durationPrecision: "exact" }; }
function operation(id) { return { kind: "operation", id }; }
function localUser() { return { kind: "local_user" }; }
function mockResponse() { return { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } }; }
