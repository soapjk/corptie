import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { BenchmarkCatalog } from "../src/benchmark/catalog.mjs";
import { contentHash, hashWithout } from "../src/benchmark/canonical.mjs";
import {
  DEPENDENCY_CONTRACT_MANIFEST, DEPENDENCY_MANIFEST_IDENTITY, RECEIPT_IDENTITY_PROFILES,
  receiptIdentitySubset, validateManifest, validateReceiptEnvelope, verifyPinnedDependencies
} from "../src/benchmark/contracts.mjs";
import { BenchmarkControlPlane } from "../src/benchmark/controlPlane.mjs";
import { ReleaseGate, DEFAULT_GATE_POLICY } from "../src/benchmark/releaseGate.mjs";
import { alternatingPairPlan, pairedStatistics } from "../src/benchmark/statistics.mjs";
import { TelemetryCorrelator } from "../src/benchmark/telemetryCorrelator.mjs";

const NOW = Date.parse("2026-08-30T06:00:00.000Z");
const scope = { logicalSessionId: "logical:test", objectiveId: "objective:test", workItemId: "work_item:test" };

test("B1 fixed Manifest contains exactly ten approved fixed authorities with stable identity", async () => {
  assert.equal(DEPENDENCY_CONTRACT_MANIFEST.entries.length, 10);
  assert.deepEqual([...DEPENDENCY_CONTRACT_MANIFEST.entries].map((entry) => `${entry.stage}:${entry.role}`),
    [...DEPENDENCY_CONTRACT_MANIFEST.entries].map((entry) => `${entry.stage}:${entry.role}`).sort());
  assert.equal(DEPENDENCY_MANIFEST_IDENTITY, contentHash(DEPENDENCY_CONTRACT_MANIFEST));
  assert.equal(validateManifest(structuredClone(DEPENDENCY_CONTRACT_MANIFEST)).manifestIdentity, DEPENDENCY_MANIFEST_IDENTITY);
  const changed = structuredClone(DEPENDENCY_CONTRACT_MANIFEST);
  changed.entries[0].version = 2;
  assert.throws(() => validateManifest(changed), { code: "BENCHMARK_DEPENDENCY_CONTRACT_MISMATCH" });
  await assert.rejects(() => verifyPinnedDependencies({ readPinned: async (entry) => ({ ...entry, complete: true, content: "wrong", readReceiptId: "read:1" }) }), { code: "BENCHMARK_RECEIPT_HASH_INVALID" });
});

test("B2 Catalog freezes S1-S7 metadata and rejects unknown fields", () => {
  const catalog = new BenchmarkCatalog();
  assert.deepEqual(catalog.list().map((item) => item.sampleId), ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
  assert.equal(catalog.suite().suiteHash, new BenchmarkCatalog().suite().suiteHash);
  const changed = { ...catalog.get("S1"), extra: true };
  delete changed.sampleHash;
  assert.throws(() => catalog.register(changed), { code: "BENCHMARK_RECEIPT_SCHEMA_INVALID" });
});

test("B1 receipt profiles accept early-stage subsets while failing missing, forbidden, hash, producer, and stale evidence closed", () => {
  const chain = receiptChain({ attemptId: "attempt:contract" });
  for (const envelope of chain) assert.equal(validateReceiptEnvelope(envelope, { now: NOW }), envelope);
  const startup = clone(chain.find((item) => item.receiptType === "StartupBindingReceipt"));
  delete startup.payload.worktreeId;
  startup.contentHash = contentHash(startup.payload);
  assert.throws(() => validateReceiptEnvelope(startup, { now: NOW }), { code: "BENCHMARK_STARTUP_REQUIRED_FIELD_MISSING" });
  const forbidden = clone(chain.find((item) => item.receiptType === "StartupBindingReceipt"));
  forbidden.payload.runId = "run:future";
  forbidden.contentHash = contentHash(forbidden.payload);
  assert.throws(() => validateReceiptEnvelope(forbidden, { now: NOW }), { code: "BENCHMARK_STAGE_FIELD_FORBIDDEN" });
  const forged = clone(chain[0]); forged.producerServiceId = "provider-adapter";
  assert.throws(() => validateReceiptEnvelope(forged, { now: NOW }), { code: "BENCHMARK_RECEIPT_PRODUCER_FORBIDDEN" });
  const badHash = clone(chain[0]); badHash.contentHash = "0".repeat(64);
  assert.throws(() => validateReceiptEnvelope(badHash, { now: NOW }), { code: "BENCHMARK_RECEIPT_HASH_INVALID" });
  const stale = clone(chain.find((item) => item.receiptType === "ToolsetValidationReceipt"));
  stale.payload.expiresAt = "2026-08-29T00:00:00.000Z"; seal(stale);
  assert.throws(() => validateReceiptEnvelope(stale, { now: NOW }), { code: "BENCHMARK_RECEIPT_STALE" });
});

test("B4 TelemetryCorrelator creates the only complete flat 12-field identity chain", () => {
  const correlation = new TelemetryCorrelator().correlate({ attemptId: "attempt:ok", receipts: receiptChain({ attemptId: "attempt:ok", search: true }), expectedScope: scope, now: NOW });
  assert.deepEqual(Object.keys(correlation.identityChain).sort(), ["catalogVersion", "logicalSessionId", "objectiveId", "observationId", "providerBindingGeneration", "providerBindingId", "repositoryId", "runId", "sourceFingerprint", "toolsetVersion", "workItemId", "worktreeId"].sort());
  assert.equal(correlation.identityChainHash, contentHash(correlation.identityChain));
  assert.equal(correlation.correlationStatus, "complete");
});

test("B4 paired cold/warm statistics are deterministic and p95 fails closed below 100 runs", () => {
  const plan = alternatingPairPlan(50, "fixed-seed");
  assert.deepEqual(plan, alternatingPairPlan(50, "fixed-seed"));
  assert.ok(plan.some((item) => item.order === "AB") && plan.some((item) => item.order === "BA"));
  const pairs = Array.from({ length: 50 }, (_, index) => ({ baseline: 100 + index, candidate: 95 + index }));
  const first = pairedStatistics(pairs, { seed: "fixed", bootstrapIterations: 500 });
  assert.deepEqual(first, pairedStatistics(pairs, { seed: "fixed", bootstrapIterations: 500 }));
  assert.equal(first.validRuns, 100);
  assert.equal(first.delta.p50, -5);
  assert.ok(first.baseline.p95 != null);
  assert.equal(pairedStatistics(pairs.slice(0, 30)).baseline.p95, null);
});

test("B5 ReleaseGate deterministically promotes, holds, stops, and requests kill without writing flags", () => {
  const gate = new ReleaseGate();
  const base = suiteReport();
  assert.equal(gate.evaluate({ report: base, killSwitchReceipt: { receiptId: "kill:off", active: false }, now: NOW }).action, "promote");
  assert.equal(gate.evaluate({ report: suiteReport({ validRuns: 60, validPairs: 30, wall: { ratio: { p95: null } } }), killSwitchReceipt: { receiptId: "kill:off", active: false }, now: NOW }).action, "hold");
  assert.equal(gate.evaluate({ report: suiteReport({ cleanupSuccessRate: 0.98 }), killSwitchReceipt: { receiptId: "kill:off", active: false }, now: NOW }).action, "stop");
  assert.equal(gate.evaluate({ report: suiteReport({ deniedPathLeakCount: 1 }), killSwitchReceipt: { receiptId: "kill:off", active: false }, now: NOW }).action, "kill_requested");
  assert.equal(gate.evaluate({ report: base, killSwitchReceipt: { receiptId: "kill:on", active: true }, now: NOW }).action, "kill_requested");
});

test("B2 Experiment/Report Store owns only the nine benchmark tables and enforces Session-scoped idempotency", () => {
  const harness = makeHarness();
  try {
    harness.control.initialize();
    assert.deepEqual(harness.control.controlStore.tableNames(), [
      "benchmark_catalog_entries", "benchmark_experiments", "benchmark_sample_plans", "benchmark_attempts",
      "benchmark_receipt_links", "benchmark_run_reports", "benchmark_suite_reports", "benchmark_gate_policies", "benchmark_gate_decisions"
    ]);
    const input = experimentInput({ sampleIds: ["S1"], pairCount: 1 });
    const first = harness.control.createExperiment(scope.logicalSessionId, input);
    const replay = harness.control.createExperiment(scope.logicalSessionId, input);
    assert.equal(replay.recordId, first.recordId);
    assert.throws(() => harness.control.createExperiment(scope.logicalSessionId, { ...input, pairCount: 2 }), { code: "BENCHMARK_IDEMPOTENCY_CONFLICT" });
    harness.store.binding.workItemId = "work_item:other";
    assert.throws(() => harness.control.getExperiment(scope.logicalSessionId, first.recordId), { code: "BENCHMARK_EXPERIMENT_NOT_FOUND" });
  } finally { harness.close(); }
});

test("B6 production chain runs Catalog→Orchestrator→TelemetryCorrelator→GateDecision for S1-S7", async () => {
  const harness = makeHarness({ ports: fakePorts(), dependencyVerifier: async () => ({ manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY, evidence: [{ artifactId: "fixed-ten", readReceiptId: "read:fixed" }] }) });
  try {
    harness.control.initialize();
    const experiment = harness.control.createExperiment(scope.logicalSessionId, experimentInput({ pairCount: 1 }));
    const result = await harness.control.runExperiment(scope.logicalSessionId, experiment.recordId);
    assert.equal(result.experiment.status, "held", "28 valid runs are intentionally below the 100-run hard p95 gate");
    assert.equal(result.decision.action, "hold");
    assert.deepEqual(new Set(result.suiteReport.receiptRefs.map((item) => item.producerServiceId)), new Set(["tool-host", "startup-binding", "repository-source-snapshot", "project-toolset", "run-isolation", "layered-search", "turn-observability"]));
    assert.equal(result.suiteReport.validRuns, 28);
    assert.equal(harness.db.get("SELECT count(*) AS count FROM benchmark_run_reports").count, 28);
    assert.equal(harness.db.get("SELECT count(*) AS count FROM benchmark_gate_decisions").count, 1);
  } finally { harness.close(); }
});

test("B6 capability classes A/B/C share one contract while D is explicit unsupported", async () => {
  for (const providerCapabilityClass of ["A", "B", "C"]) {
    const harness = makeHarness({ ports: fakePorts({ observabilityLevel: providerCapabilityClass === "C" ? "boundary-only" : "event-stream" }), dependencyVerifier: verifiedDependencies });
    try {
      harness.control.initialize();
      const experiment = harness.control.createExperiment(scope.logicalSessionId, experimentInput({ sampleIds: ["S2"], pairCount: 1, providerCapabilityClass, idempotencyKey: `cap-${providerCapabilityClass}` }));
      const result = await harness.control.runExperiment(scope.logicalSessionId, experiment.recordId);
      assert.equal(result.decision.action, "hold");
      assert.equal(result.suiteReport.providerCapabilityClass, providerCapabilityClass);
    } finally { harness.close(); }
  }
  const harness = makeHarness({ ports: fakePorts(), dependencyVerifier: verifiedDependencies });
  try {
    harness.control.initialize();
    const experiment = harness.control.createExperiment(scope.logicalSessionId, experimentInput({ sampleIds: ["S2"], pairCount: 1, providerCapabilityClass: "D", idempotencyKey: "cap-D" }));
    const held = await harness.control.runExperiment(scope.logicalSessionId, experiment.recordId);
    assert.equal(held.status, "held");
    assert.equal(held.payload.capabilityEvidence.code, "CAPABILITY_UNSUPPORTED");
  } finally { harness.close(); }
});

test("B3 restart recovery queries authoritative receipts and never resends an unknown Provider turn", async () => {
  let sessionExecutions = 0;
  const ports = fakePorts();
  ports.sessionExecutionPort.execute = async ({ attemptId }) => { sessionExecutions += 1; return executionReceipt(attemptId); };
  ports.sessionExecutionPort.query = async ({ receiptRef }) => receiptRef;
  const harness = makeHarness({ ports, dependencyVerifier: verifiedDependencies });
  try {
    harness.control.initialize();
    let experiment = harness.control.createExperiment(scope.logicalSessionId, experimentInput({ sampleIds: ["S1"], pairCount: 1, idempotencyKey: "recovery" }));
    experiment = harness.control.controlStore.transitionExperiment(scope, experiment.recordId, experiment.resourceVersion, "prerequisites_verified");
    experiment = harness.control.controlStore.transitionExperiment(scope, experiment.recordId, experiment.resourceVersion, "dispatched");
    experiment = harness.control.controlStore.transitionExperiment(scope, experiment.recordId, experiment.resourceVersion, "awaiting_evidence");
    const plan = experiment.payload.definition.samplePlans[0];
    const attempt = harness.control.controlStore.createAttempt(scope, experiment.recordId, plan.recordId, plan.variantOrder[0]);
    harness.control.controlStore.updateAttemptControl(attempt.recordId, "execution_dispatching", `run:${attempt.recordId}`,
      { sessionExecutionRef: executionReceipt(attempt.recordId) });
    const result = await harness.control.runExperiment(scope.logicalSessionId, experiment.recordId);
    assert.equal(result.experiment.status, "held");
    assert.equal(sessionExecutions, 3, "one uncertain attempt was queried while the other three were dispatched once");
  } finally { harness.close(); }
});

test("architecture keeps external business state and concrete Providers out of Benchmark modules", async () => {
  const root = new URL("../src/benchmark/", import.meta.url);
  const files = (await readdir(root)).filter((name) => name.endsWith(".mjs"));
  const source = (await Promise.all(files.map((name) => readFile(new URL(name, root), "utf8")))).join("\n");
  for (const forbidden of ["codexClient", "claudeAgents", "OpenClacky", "GitWorkspace", "projectToolsetManager", "ResourceLeaseService", "RepositorySearchService", "node:child_process", "process.kill", "recordObservation(", "benchmark_production_composition"]) {
    assert.equal(source.includes(forbidden), false, `Benchmark must not import or own ${forbidden}`);
  }
  const harness = makeHarness();
  try {
    harness.control.initialize();
    const columns = harness.control.controlStore.tableNames().flatMap((table) => harness.db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
    for (const forbiddenColumn of ["pid", "port", "lease_secret", "worktree_path", "search_index", "raw_telemetry", "feature_flag_state"]) assert.equal(columns.includes(forbiddenColumn), false);
  } finally { harness.close(); }
});

test("B6 F1-F12 failure injections fail closed with hold/stop/kill/invalid evidence", async (t) => {
  const base = receiptChain({ attemptId: "attempt:f" });
  await t.test("F1 missing observation holds as incomplete", () => {
    assert.throws(() => new TelemetryCorrelator().correlate({ attemptId: "a", receipts: base.filter((item) => item.receiptType !== "Observation"), expectedScope: scope, now: NOW }), { code: "ATTEMPT_IDENTITY_INCOMPLETE" });
  });
  await t.test("F2 replaced Artifact/receipt hash is rejected", () => { const value = clone(base[0]); value.contentHash = "f".repeat(64); assert.throws(() => validateReceiptEnvelope(value), { code: "BENCHMARK_RECEIPT_HASH_INVALID" }); });
  await t.test("F3 binding generation change invalidates identity", () => { const value = clone(base); const observation = value.find((item) => item.receiptType === "Observation"); observation.payload.identity.bindingGeneration += 1; seal(observation); assert.throws(() => correlate(value), { code: "BENCHMARK_IDENTITY_CHAIN_MISMATCH" }); });
  await t.test("F4 catalog mismatch is rejected", () => { const value = clone(base); const observation = value.find((item) => item.receiptType === "Observation"); observation.payload.versions.catalogVersion = "catalog:other"; seal(observation); assert.throws(() => correlate(value), { code: "BENCHMARK_IDENTITY_CHAIN_MISMATCH" }); });
  await t.test("F5 Toolset snapshot mismatch is rejected", () => { const value = clone(base); const toolset = value.find((item) => item.receiptType === "ToolsetValidationReceipt"); toolset.payload.snapshotRef.sourceFingerprint = "fp:other"; toolset.payload.receiptHash = hashWithout(toolset.payload, "receiptHash"); seal(toolset); assert.throws(() => correlate(value), { code: "BENCHMARK_IDENTITY_CHAIN_MISMATCH" }); });
  await t.test("F6 foreign process evidence requests kill", () => assert.equal(gateAction({ foreignProcessKillCount: 1 }), "kill_requested"));
  await t.test("F7 incomplete cleanup stops", () => assert.equal(gateAction({ cleanupSuccessRate: 0.98 }), "stop"));
  await t.test("F8 denied path leak requests kill", () => assert.equal(gateAction({ deniedPathLeakCount: 1 }), "kill_requested"));
  await t.test("F9 unsupported is never supported pass", () => assert.equal(gateAction({ validRuns: 0, validPairs: 0 }), "hold"));
  await t.test("F10 insufficient sample has no p95 and holds", () => { const stats = pairedStatistics(Array.from({ length: 30 }, () => ({ baseline: 1, candidate: 1 }))); assert.equal(stats.baseline.p95, null); assert.equal(gateAction({ validRuns: 60, validPairs: 30, wall: { ratio: { p95: null } } }), "hold"); });
  await t.test("F11 forged producer is rejected", () => { const value = clone(base[0]); value.producerServiceId = "self-reported"; assert.throws(() => validateReceiptEnvelope(value), { code: "BENCHMARK_RECEIPT_PRODUCER_FORBIDDEN" }); });
  await t.test("F12 external data-root failure is retained as a safe held error", async () => {
    const ports = fakePorts(); ports.runIsolationScenarioPort.execute = async () => { const error = new Error("external disk unavailable /private/path redacted"); error.code = "DATA_ROOT_UNAVAILABLE"; error.safeMessage = "External data root is unavailable."; throw error; };
    const harness = makeHarness({ ports, dependencyVerifier: verifiedDependencies });
    try {
      harness.control.initialize(); const experiment = harness.control.createExperiment(scope.logicalSessionId, experimentInput({ sampleIds: ["S1"], pairCount: 1, idempotencyKey: "f12" }));
      await assert.rejects(() => harness.control.runExperiment(scope.logicalSessionId, experiment.recordId), { code: "DATA_ROOT_UNAVAILABLE" });
      const held = harness.control.getExperiment(scope.logicalSessionId, experiment.recordId);
      assert.equal(held.status, "held"); assert.equal(held.payload.error.safeMessage, "External data root is unavailable."); assert.equal(JSON.stringify(held.payload).includes("/private/path"), false);
    } finally { harness.close(); }
  });
});

function makeHarness(options = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const db = new TestDatabase(database);
  const store = {
    db, binding: { ...scope },
    assertLogicalWorkSessionBinding(logicalSessionId) {
      if (logicalSessionId !== this.binding.logicalSessionId) throw Object.assign(new Error("not found"), { code: "WORK_SESSION_BINDING_INVALID" });
      return { ...this.binding };
    }
  };
  const control = new BenchmarkControlPlane({ store, ports: options.ports ?? {}, now: () => NOW, dependencyVerifier: options.dependencyVerifier });
  return { control, store, db, close: () => database.close() };
}

class TestDatabase {
  constructor(database) { this.database = database; this.rowsModified = 0; }
  run(sql, params = []) { if (params.length) { const result = this.database.prepare(sql).run(...params); this.rowsModified = Number(result.changes); } else { this.database.exec(sql); this.rowsModified = Number(this.database.prepare("SELECT changes() AS count").get().count); } }
  get(sql, params = []) { return this.database.prepare(sql).get(...params) ?? null; }
  all(sql, params = []) { return this.database.prepare(sql).all(...params); }
  getRowsModified() { return this.rowsModified; }
}

function experimentInput(overrides = {}) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? "experiment-key", sampleIds: overrides.sampleIds,
    pairCount: overrides.pairCount ?? 1, providerCapabilityClass: overrides.providerCapabilityClass ?? "A",
    noiseProfile: { machineClass: "mac", osBuild: "26A", cpuArchitecture: "arm64", memoryClass: "64gb", powerState: "ac", thermalState: "nominal", filesystemClass: "external-apfs", providerCapabilityClass: overrides.providerCapabilityClass ?? "A", observabilityLevel: "event-stream" },
    stage: "shadow", cohortRef: null, gatePolicy: DEFAULT_GATE_POLICY, randomSeed: "fixed"
  };
}

const verifiedDependencies = async () => ({ manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY, evidence: [{ artifactId: "ten-fixed", readReceiptId: "read:ten" }] });

function fakePorts(options = {}) {
  return {
    artifactEvidencePort: {},
    rolloutActuatorReadPort: { readKillSwitch: async () => ({ receiptId: "kill:off", active: false }) },
    toolHostReceiptPort: { queryAppliedReceipt: async (request) => authority("ToolHostAppliedReceipt", request) },
    startupBindingReceiptPort: { queryReadyReceipt: async (request) => authority("StartupBindingReceipt", request) },
    repositorySourceSnapshotPort: { preflight: async (request) => authority("RepositorySourceSnapshotReceipt", request) },
    projectToolsetReceiptPort: { queryValidationReceipt: async (request) => authority("ToolsetValidationReceipt", request) },
    runIsolationScenarioPort: {
      execute: async (request) => authority("RunReceipt", request),
      queryRunReceipt: async (request) => authority("RunReceipt", request),
      cleanup: async ({ runReceipt, ...request }) => authority("CleanupReceipt", { ...request, runId: runReceipt.payload.runId }),
      queryCleanupReceipt: async ({ runReceipt, ...request }) => authority("CleanupReceipt", { ...request, runId: runReceipt.payload.runId })
    },
    sessionExecutionPort: {
      execute: async ({ attemptId }) => executionReceipt(attemptId),
      query: async ({ receiptRef }) => receiptRef,
      cancel: async () => ({ accepted: true })
    },
    layeredSearchScenarioPort: {
      execute: async ({ runReceipt, cleanupReceipt, ...request }) => authority("SearchReceipt", { ...request, runId: runReceipt.payload.runId, cleanupReceipt }),
      queryReceipt: async ({ runReceipt, cleanupReceipt, ...request }) => authority("SearchReceipt", { ...request, runId: runReceipt.payload.runId, cleanupReceipt })
    },
    observabilityQueryPort: {
      queryObservation: async ({ runReceipt, ...request }) => authority("Observation", { ...request, runId: runReceipt.payload.runId }),
      queryExport: async ({ runReceipt, ...request }) => authority("ObservationExport", { ...request, runId: runReceipt.payload.runId }, { observabilityLevel: options.observabilityLevel ?? "event-stream" })
    }
  };
}

function executionReceipt(attemptId) {
  return { receiptId: `turn_execution_receipt:${attemptId}`, turnExecutionId: `execution:${attemptId}`,
    turnId: `turn:${attemptId}`, logicalSessionId: scope.logicalSessionId };
}

function receiptChain({ attemptId, search = false }) {
  const request = { scope, experimentId: "experiment:test", attemptId, sampleId: "S1", pairIndex: 0, mode: "cold", variant: "A" };
  const values = ["ToolHostAppliedReceipt", "StartupBindingReceipt", "RepositorySourceSnapshotReceipt", "ToolsetValidationReceipt", "RunReceipt", "CleanupReceipt"]
    .map((type) => authority(type, request));
  if (search) values.push(authority("SearchReceipt", request));
  values.push(authority("Observation", request));
  values.push(authority("ObservationExport", request));
  return values;
}

function authority(type, request, envelopeOverrides = {}) {
  const profile = RECEIPT_IDENTITY_PROFILES[type];
  const payload = Object.fromEntries(profile.fields.map((field) => [field, null]));
  const id = `${type.toLowerCase()}:${request.attemptId}`;
  const bindingId = `binding:${request.attemptId}`;
  const snapshotId = `snapshot:${request.attemptId}`;
  const runId = request.runId ?? `run:${request.attemptId}`;
  const fingerprint = `source:${contentHash(request.attemptId)}`;
  Object.assign(payload, payloadFor(type, { request, id, bindingId, snapshotId, runId, fingerprint }));
  if (type === "ObservationExport" && envelopeOverrides.observabilityLevel) payload.samplePolicy.observabilityLevel = envelopeOverrides.observabilityLevel;
  if (Object.hasOwn(payload, "receiptHash")) payload.receiptHash = hashWithout(payload, "receiptHash");
  if (type === "ObservationExport") payload.summaryHash = hashWithout(payload, "summaryHash");
  const receiptId = payload.receiptId ?? payload.readReceiptId ?? payload.startupOperationId ?? payload.observationId ?? `observation_export:${payload.summaryHash}`;
  return {
    receiptId, receiptType: type, producerServiceId: profile.producer, schemaVersion: profile.schemaVersion,
    identitySubset: receiptIdentitySubset(type, payload), identityProfileVersion: 1, requestHash: contentHash(request), contentHash: contentHash(payload),
    issuedAt: "2026-08-30T05:59:00.000Z", status: "issued",
    metrics: envelopeOverrides.metrics ?? {}, evidence: [{ kind: "assertion", locator: `receipt:${receiptId}`, hash: contentHash(receiptId), command: "node --test", exitCode: 0, assertionSummary: "fixed assertion passed" }], error: null, payload
  };
}

function payloadFor(type, c) {
  const { request, id, bindingId, snapshotId, runId, fingerprint } = c;
  const identity = { objectiveId: scope.objectiveId, workItemId: scope.workItemId, logicalSessionId: scope.logicalSessionId, providerBindingId: bindingId, bindingGeneration: 7, repositoryId: "repository:test", worktreeId: "worktree:test", turnId: `turn:${request.attemptId}` };
  const artifactRef = { artifactId: "artifact:contract", version: 1, contentHash: "a".repeat(64), relation: "implementation_spec", receiptType: type, schemaVersion: RECEIPT_IDENTITY_PROFILES[type].schemaVersion };
  const snapshotRef = { receiptId: snapshotId, receiptHash: "b".repeat(64), sourceFingerprint: fingerprint, schemaVersion: 1, resourceVersion: 1, artifactRef: { ...artifactRef, receiptType: "RepositorySourceSnapshotReceipt", schemaVersion: 1 } };
  const startupRef = { receiptId: `startupbindingreceipt:${request.attemptId}`, receiptHash: "c".repeat(64), schemaVersion: 2, resourceVersion: 1, artifactRef: { ...artifactRef, receiptType: "StartupBindingReceipt", schemaVersion: 2 } };
  const toolsetRef = { receiptId: `toolsetvalidationreceipt:${request.attemptId}`, receiptHash: "d".repeat(64), resourceVersion: 1, toolsetVersion: "ptv1:fixed", validationPlanIdentity: "vp1:fixed", sourceFingerprint: fingerprint };
  switch (type) {
    case "ToolHostAppliedReceipt": return { providerBindingId: bindingId, providerCapabilityRevision: "cap:1", requestedVersion: "materialization:1", appliedVersion: "materialization:1", appliedCatalogVersion: "catalog:1", appliedDomains: ["artifacts"], appliedExposurePlanHash: "e".repeat(64), refreshMode: "replace", providerRevision: "provider:1", receiptId: id, appliedAt: "2026-08-30T05:50:00.000Z" };
    case "StartupBindingReceipt": return { schemaVersion: 2, status: "ready", startupOperationId: id, objectiveId: scope.objectiveId, workItemId: scope.workItemId, logicalSessionId: scope.logicalSessionId, repositoryId: "repository:test", worktreeId: "worktree:test", canonicalWorktreePath: "/redacted", headIdentity: { oid: "1" }, providerBindingId: bindingId, bindingGeneration: 7, sourceCommitOid: "1".repeat(40), sourceTreeOid: "2".repeat(40), baseRef: "refs/heads/test", repositoryInventoryVersion: "inventory:1", workspaceResourceVersion: 1, resourceVersion: 1, providerContextHash: "f".repeat(64), phaseTimestamps: {}, compensation: null, error: null };
    case "RepositorySourceSnapshotReceipt": return { receiptId: snapshotId, schemaVersion: 1, resourceVersion: 1, artifactRef, startupBindingRef: startupRef, objectiveId: scope.objectiveId, workItemId: scope.workItemId, logicalSessionId: scope.logicalSessionId, repositoryId: "repository:test", worktreeId: "worktree:test", sourceCommitOid: "1".repeat(40), sourceTreeOid: "2".repeat(40), dirtyOverlayRef: null, ignoreConfigRevisionRef: "ignore:1", scopeRootHash: "3".repeat(64), sourceFingerprint: fingerprint, createdAt: "2026-08-30T05:51:00.000Z" };
    case "ToolsetValidationReceipt": return { receiptId: id, schemaVersion: 3, resourceVersion: 1, artifactRef, identity: { logicalSessionId: scope.logicalSessionId, objectiveId: scope.objectiveId, workItemId: scope.workItemId, repositoryId: "repository:test", worktreeId: "worktree:test", startupBindingRef: startupRef }, snapshotRef, toolsetVersion: "ptv1:fixed", validationPlanIdentity: "vp1:fixed", validationCacheKey: "cache:1", actionReceipts: [], assertionReceipts: [], cacheDisposition: request.mode === "warm" ? "reused" : "cold", outcome: "passed", startedAt: "2026-08-30T05:52:00.000Z", finishedAt: "2026-08-30T05:53:00.000Z", expiresAt: "2026-08-31T05:53:00.000Z", error: null };
    case "RunReceipt": return { schemaVersion: 6, receiptId: id, runId, mode: "benchmark", logicalSessionId: scope.logicalSessionId, workItemId: scope.workItemId, repositoryId: "repository:test", worktreeId: "worktree:test", sourceFingerprint: fingerprint, startupBindingReceiptRef: startupRef, repositorySourceSnapshotReceiptRef: snapshotRef, toolsetValidationReceiptPointer: toolsetRef, state: "completed", outcome: "passed", runContextHash: "4".repeat(64), dataRootBindingId: "external:test", processLeaseRefs: [], portLeaseRefs: [], dataLeaseRef: null, credentialLeaseRefs: [], fencingToken: 1, resourceVersion: 1, eventRefs: [], metricsRef: null, readyAt: "2026-08-30T05:54:00.000Z", startedAt: "2026-08-30T05:54:00.000Z", stoppedAt: "2026-08-30T05:55:00.000Z", completedAt: "2026-08-30T05:55:00.000Z", error: null };
    case "CleanupReceipt": return { schemaVersion: 4, receiptId: id, cleanupOperationId: `cleanup:${request.attemptId}`, runId, runReceiptRef: { receiptId: `runreceipt:${request.attemptId}`, receiptHash: "5".repeat(64), resourceVersion: 1, runId }, logicalSessionId: scope.logicalSessionId, workItemId: scope.workItemId, repositoryId: "repository:test", worktreeId: "worktree:test", sourceFingerprint: fingerprint, outcome: "cleaned", policy: "delete", ownerSessionId: scope.logicalSessionId, retentionReason: null, retentionPolicyVersion: 1, retainUntil: null, quotaBytes: 0, observedBytes: 0, fencingToken: 1, resourceVersion: 1, dataRootBindingId: "external:test", sourceIdentityHash: "6".repeat(64), trashIdentityHash: null, safetyChecks: [], processReconciliation: {}, bytesReclaimed: 0, filesRemoved: 0, eventRefs: [], startedAt: "2026-08-30T05:55:00.000Z", finishedAt: "2026-08-30T05:56:00.000Z", error: null };
    case "SearchReceipt": return { receiptId: id, schemaVersion: 1, resourceVersion: 1, artifactRef, createdAt: "2026-08-30T05:57:00.000Z", searchScenarioId: "search:S6", startupBindingRef: startupRef, snapshotReceiptRef: snapshotRef, sourceFingerprint: fingerprint, toolsetValidationReceiptRef: toolsetRef, runIsolationReceiptRef: { receiptId: `runreceipt:${request.attemptId}`, runId }, runId, cleanupReceiptRef: { receiptId: `cleanupreceipt:${request.attemptId}`, runId }, queryHash: "7".repeat(64), scopeHash: "8".repeat(64), indexVersion: "index:1", candidateCategories: ["source"], layers: [], latency: { totalMs: 10 }, resultSummary: { recall: 1, deniedPathLeak: 0 }, cancellation: false, timeout: false, rejectedPaths: [], rejectedPathOverflowCount: 0, evidenceRefs: [], outcome: "passed", errorCode: null };
    case "Observation": return { schemaVersion: 3, observationId: id, turnExecutionId: `execution:${request.attemptId}`, runId, operationRef: null, identity, sourceIdentity: null, versions: { catalogVersion: "catalog:1", desiredMaterializationVersion: "materialization:1", appliedMaterializationVersion: "materialization:1", toolsetVersion: "ptv1:fixed", sourceFingerprint: fingerprint, providerCapabilityRevision: "cap:1" }, receiptRefs: [], producer: "provider-event-ingestion", producerEventId: `event:${request.attemptId}`, eventType: "turn.completed", observedAtUnixNano: "1788069600000000000", monotonicNano: "1", clockDomainId: "clock:1", sourceOccurredAtUnixNano: null, sourceClockQuality: "estimate", producerSequence: 1, safeAttributes: {}, status: "complete", errorCode: null, idempotencyFingerprint: "9".repeat(64) };
    case "ObservationExport": return { schemaVersion: 4, analysisVersion: 4, identity, sourceIdentity: null, versions: { catalogVersion: "catalog:1", desiredMaterializationVersion: "materialization:1", appliedMaterializationVersion: "materialization:1", toolsetVersion: "ptv1:fixed", sourceFingerprint: fingerprint, providerCapabilityRevision: "cap:1" }, wall: { wallClockMs: request.variant === "A" ? 100 : 95, criticalPathMs: 80 }, wallPartition: [], inclusive: { modelInclusiveMs: 60, toolInclusiveMs: 25, modelInvocationCount: 1, samplingCount: 1, toolCallCount: 1 }, unattributed: { unattributedMs: 5, ratio: 0.05 }, contextGrowth: { inputTokens: null, contextBytes: null }, completeness: { value: 0.99, level: "complete" }, diagnostics: [], samplePolicy: { observabilityLevel: "event-stream" }, sourceReceiptIds: [`observation:${request.attemptId}`], summaryHash: null };
    default: throw new Error(type);
  }
}

function suiteReport(overrides = {}) {
  const body = { reportId: "suite:test", schemaVersion: 2, providerCapabilityClass: "A", validRuns: 100, validPairs: 50, minimumSegmentValidPairs: 50, minimumSegmentValidRuns: 100, wall: { ratio: { p95: 1 } }, functionalSuccessDelta: 0, identityCorrelationRate: 1, cleanupSuccessRate: 1, safetyViolations: [], falseSuccessCount: 0, deniedPathLeakCount: 0, foreignProcessKillCount: 0, sensitiveLeakCount: 0, scopePollutionCount: 0, receiptRefs: [{ receiptId: "receipt:1" }], evidenceRefs: ["receipt:1"], ...overrides };
  return { ...body, contentHash: contentHash(body) };
}

function gateAction(overrides) { return new ReleaseGate().evaluate({ report: suiteReport(overrides), killSwitchReceipt: { receiptId: "kill:off", active: false }, now: NOW }).action; }
function correlate(receipts) { return new TelemetryCorrelator().correlate({ attemptId: "attempt:f", receipts, expectedScope: scope, now: NOW }); }
function clone(value) { return structuredClone(value); }
function seal(envelope) { if (Object.hasOwn(envelope.payload, "receiptHash")) envelope.payload.receiptHash = hashWithout(envelope.payload, "receiptHash"); if (envelope.receiptType === "ObservationExport") envelope.payload.summaryHash = hashWithout(envelope.payload, "summaryHash"); envelope.identitySubset = receiptIdentitySubset(envelope.receiptType, envelope.payload); envelope.contentHash = contentHash(envelope.payload); return envelope; }
