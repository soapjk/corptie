import { assertClosedObject, benchmarkError, contentHash } from "./canonical.mjs";
import { BenchmarkCatalog } from "./catalog.mjs";
import { DEPENDENCY_CONTRACT_MANIFEST, DEPENDENCY_MANIFEST_IDENTITY } from "./contracts.mjs";
import { BenchmarkControlStore } from "./controlStore.mjs";
import { BenchmarkOrchestrator } from "./orchestrator.mjs";
import { DEFAULT_GATE_POLICY, ReleaseGate } from "./releaseGate.mjs";
import { alternatingPairPlan, validateNoiseProfile } from "./statistics.mjs";
import { TelemetryCorrelator } from "./telemetryCorrelator.mjs";

export class BenchmarkControlPlane {
  constructor({ store, ports = {}, catalog = new BenchmarkCatalog(), now, idFactory, dependencyVerifier }) {
    this.store = store;
    this.catalog = catalog;
    this.controlStore = new BenchmarkControlStore({ store, now: now ? () => new Date(now()).toISOString() : undefined, idFactory });
    this.correlator = new TelemetryCorrelator();
    this.releaseGate = new ReleaseGate();
    this.orchestrator = new BenchmarkOrchestrator({ controlStore: this.controlStore, correlator: this.correlator, releaseGate: this.releaseGate, ports, now, dependencyVerifier });
  }

  initialize() { this.controlStore.initialize(); }
  manifest() { return { manifest: DEPENDENCY_CONTRACT_MANIFEST, manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY }; }
  catalogList() { return this.catalog.suite(); }
  catalogGet(sampleId) { const sample = this.catalog.get(sampleId); if (!sample) throw benchmarkError("BENCHMARK_CATALOG_NOT_FOUND", "Catalog sample not found.", "catalog", { statusCode: 404 }); return sample; }

  createExperiment(logicalSessionId, input) {
    assertClosedObject(input, ["idempotencyKey", "sampleIds", "pairCount", "providerCapabilityClass", "noiseProfile", "stage", "cohortRef", "gatePolicy", "randomSeed"], "BenchmarkExperimentInput");
    const scope = this.#scope(logicalSessionId);
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw benchmarkError("BENCHMARK_INPUT_INVALID", "idempotencyKey must contain 1-200 characters.", "experiment");
    const suite = this.catalog.suite();
    this.controlStore.syncCatalog(scope.logicalSessionId, suite);
    const sampleIds = input.sampleIds ?? suite.samples.map((sample) => sample.sampleId);
    if (!Array.isArray(sampleIds) || sampleIds.length === 0 || new Set(sampleIds).size !== sampleIds.length) throw benchmarkError("BENCHMARK_INPUT_INVALID", "sampleIds must be a non-empty unique array.", "experiment");
    const samples = sampleIds.map((id) => this.catalogGet(id));
    const pairCount = input.pairCount ?? 50;
    if (!Number.isInteger(pairCount) || pairCount < 1 || pairCount > 1_000) throw benchmarkError("BENCHMARK_INPUT_INVALID", "pairCount must be an integer from 1 through 1000.", "experiment");
    const randomSeed = input.randomSeed ?? "corptie-ab-v1";
    const providerCapabilityClass = normalizeCapabilityClass(input.providerCapabilityClass);
    const noiseProfileHash = validateNoiseProfile(input.noiseProfile);
    if (input.noiseProfile.providerCapabilityClass !== providerCapabilityClass) throw benchmarkError("BENCHMARK_NOISE_PROFILE_INVALID", "Noise profile capability class does not match the experiment.", "experiment");
    const stage = input.stage ?? "shadow";
    if (!["shadow", "cohort"].includes(stage)) throw benchmarkError("BENCHMARK_INPUT_INVALID", "Experiment stage must be shadow or cohort.", "experiment");
    const gatePolicy = { ...DEFAULT_GATE_POLICY, ...(input.gatePolicy ?? {}) };
    if (input.gatePolicy != null) assertClosedObject(input.gatePolicy, Object.keys(DEFAULT_GATE_POLICY), "BenchmarkGatePolicy");
    for (const [key, value] of Object.entries(gatePolicy)) {
      if (key === "gatePolicyId") {
        if (typeof value !== "string" || !value) throw benchmarkError("BENCHMARK_INPUT_INVALID", "gatePolicyId must be non-empty.", "experiment");
      } else if (!Number.isFinite(value) || (key !== "nonInferiorityMargin" && value < 0)) throw benchmarkError("BENCHMARK_INPUT_INVALID", `Gate policy ${key} has an invalid numeric value.`, "experiment");
    }
    const experimentId = `experiment:${contentHash({ logicalSessionId: scope.logicalSessionId, idempotencyKey: input.idempotencyKey }).slice(0, 32)}`;
    const samplePlans = [];
    for (const sample of samples) for (const mode of ["cold", "warm"]) for (const pair of alternatingPairPlan(pairCount, `${randomSeed}:${sample.sampleId}:${mode}`)) {
      const storedPairIndex = pair.pairIndex + (mode === "warm" ? pairCount : 0);
      const recordId = `sample_plan:${contentHash({ experimentId, sampleId: sample.sampleId, pairIndex: storedPairIndex }).slice(0, 32)}`;
      samplePlans.push({ recordId, sampleId: sample.sampleId, sizeClass: sample.sizeClass, performanceBudgetId: sample.performanceBudgetId, pairIndex: storedPairIndex, comparisonPairIndex: pair.pairIndex, variantOrder: pair.order, mode, search: sample.sampleId === "S6" });
    }
    const definition = {
      suiteHash: suite.suiteHash, sampleIds, pairCount, samplePlans,
      providerCapabilityClass, noiseProfile: input.noiseProfile, noiseProfileHash,
      stage, cohortRef: input.cohortRef ?? null,
      gatePolicy, randomSeed,
      functionalSuccessDelta: 0, safetyViolations: []
    };
    const experiment = this.controlStore.createExperiment(scope, { definition, idempotencyKey: input.idempotencyKey, manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY });
    for (const plan of samplePlans) this.controlStore.createSamplePlan(scope, experiment.recordId, this.catalogGet(plan.sampleId), plan.pairIndex, plan.variantOrder);
    return experiment;
  }

  getExperiment(logicalSessionId, experimentId) { return this.controlStore.getExperiment(this.#scope(logicalSessionId), experimentId); }
  listExperiments(logicalSessionId) { return this.controlStore.listExperiments(this.#scope(logicalSessionId)); }
  runExperiment(logicalSessionId, experimentId) { return this.orchestrator.run(this.#scope(logicalSessionId), experimentId); }
  cancelExperiment(logicalSessionId, experimentId, resourceVersion) { return this.orchestrator.cancel(this.#scope(logicalSessionId), experimentId, resourceVersion); }
  getReport(logicalSessionId, reportId) { return this.controlStore.getReport(this.#scope(logicalSessionId), reportId); }
  getDecision(logicalSessionId, decisionId) { return this.controlStore.getGateDecision(this.#scope(logicalSessionId), decisionId); }

  #scope(logicalSessionId) {
    const binding = this.store.assertLogicalWorkSessionBinding(logicalSessionId);
    if (!binding.objectiveId || !binding.workItemId) throw benchmarkError("BENCHMARK_WORK_SESSION_REQUIRED", "Benchmark writes require a bound Worker Session.", "authorization", { statusCode: 403 });
    return { logicalSessionId: binding.logicalSessionId, objectiveId: binding.objectiveId, workItemId: binding.workItemId };
  }
}

function normalizeCapabilityClass(value) {
  if (!["A", "B", "C", "D"].includes(value)) throw benchmarkError("BENCHMARK_CAPABILITY_CLASS_INVALID", "Provider capability class must be A, B, C, or D.", "experiment");
  return value;
}
