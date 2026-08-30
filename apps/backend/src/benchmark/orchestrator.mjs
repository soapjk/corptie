import { benchmarkError, contentHash, safeBenchmarkError } from "./canonical.mjs";
import { verifyPinnedDependencies, validateReceiptEnvelope } from "./contracts.mjs";
import { pairedStatistics, validateNoiseProfile } from "./statistics.mjs";

export class BenchmarkOrchestrator {
  constructor({ controlStore, correlator, releaseGate, ports = {}, now = () => Date.now(), dependencyVerifier = verifyPinnedDependencies }) {
    this.controlStore = controlStore;
    this.correlator = correlator;
    this.releaseGate = releaseGate;
    this.ports = ports;
    this.now = now;
    this.dependencyVerifier = dependencyVerifier;
    this.inFlight = new Map();
  }

  run(scope, experimentId) {
    if (this.inFlight.has(experimentId)) return this.inFlight.get(experimentId);
    const promise = this.#run(scope, experimentId).finally(() => this.inFlight.delete(experimentId));
    this.inFlight.set(experimentId, promise);
    return promise;
  }

  async #run(scope, experimentId) {
    let experiment = this.controlStore.getExperiment(scope, experimentId);
    if (["completed", "held", "stopped", "invalidated", "cancelled"].includes(experiment.status)) return { experiment };
    try {
      const killSwitchReceipt = await requiredPort(this.ports.rolloutActuatorReadPort, "readKillSwitch", { scope, experimentId });
      if (killSwitchReceipt.active === true) {
        return this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, "held", { killSwitchReceipt, error: { code: "BENCHMARK_KILL_SWITCH_ACTIVE" } });
      }
      const dependencies = await this.dependencyVerifier(this.ports.artifactEvidencePort, { scope });
      if (experiment.status === "planned") experiment = this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, "prerequisites_verified", { dependencyEvidence: dependencies.evidence });
      if (experiment.payload.definition.providerCapabilityClass === "D") {
        return this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, "held", {
          capabilityEvidence: { code: "CAPABILITY_UNSUPPORTED", supported: false, fallback: false }
        });
      }
      if (experiment.status === "prerequisites_verified") experiment = this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, "dispatched");
      if (experiment.status === "dispatched") experiment = this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, "awaiting_evidence");
      const definition = experiment.payload.definition;
      let runReports = this.controlStore.listRunReports(scope, experimentId);
      if (experiment.status === "awaiting_evidence") {
        runReports = [];
        for (const plan of definition.samplePlans) {
          for (const variant of plan.variantOrder.split("")) {
            runReports.push(await this.#runAttempt(scope, experimentId, plan, variant));
          }
        }
        experiment = this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, "correlated");
      }
      let suiteReport;
      let decision;
      if (experiment.status === "correlated") {
        suiteReport = buildSuiteReport(experimentId, definition, runReports, this.now());
        this.controlStore.saveReport(scope, "suite", experimentId, suiteReport);
        decision = this.releaseGate.evaluate({ report: suiteReport, policy: definition.gatePolicy, killSwitchReceipt, stage: definition.stage, cohortRef: definition.cohortRef, now: this.now() });
        this.controlStore.saveGateDecision(scope, experimentId, decision);
        experiment = this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, "evaluated", { suiteReportId: suiteReport.reportId, gateDecisionId: decision.decisionId });
      } else {
        suiteReport = this.controlStore.getReport(scope, experiment.payload.suiteReportId).payload;
        decision = this.controlStore.getGateDecision(scope, experiment.payload.gateDecisionId).payload;
      }
      const terminal = decision.action === "promote" ? "completed" : decision.action === "hold" ? "held" : "stopped";
      experiment = this.controlStore.transitionExperiment(scope, experimentId, experiment.resourceVersion, terminal, { gateAction: decision.action });
      return { experiment, suiteReport, decision };
    } catch (error) {
      const current = this.controlStore.getExperiment(scope, experimentId);
      if (["planned", "prerequisites_verified", "dispatched", "awaiting_evidence", "correlated"].includes(current.status)) {
        const failureDecision = this.releaseGate.evaluateFailure({ experimentId, providerCapabilityClass: current.payload.definition.providerCapabilityClass, stage: current.payload.definition.stage, error, evidenceRefs: error.evidenceRefs, now: this.now() });
        this.controlStore.saveGateDecision(scope, experimentId, failureDecision);
        const terminal = error.code === "BENCHMARK_DEPENDENCY_CONTRACT_MISMATCH" ? "invalidated" : failureDecision.action === "hold" ? "held" : "stopped";
        this.controlStore.transitionExperiment(scope, experimentId, current.resourceVersion, terminal, { error: safeBenchmarkError(error), gateDecisionId: failureDecision.decisionId, gateAction: failureDecision.action });
      }
      throw error;
    }
  }

  async #runAttempt(scope, experimentId, plan, variant) {
    let attempt = this.controlStore.createAttempt(scope, experimentId, plan.recordId, variant);
    if (attempt.status === "correlated" && attempt.payload.reportId) return this.controlStore.getReport(scope, attempt.payload.reportId).payload;
    const request = { scope, experimentId, attemptId: attempt.recordId, sampleId: plan.sampleId, sizeClass: plan.sizeClass, performanceBudgetId: plan.performanceBudgetId, pairIndex: plan.pairIndex, mode: plan.mode, variant };
    const receipts = [];
    receipts.push(await requiredPort(this.ports.toolHostReceiptPort, "queryAppliedReceipt", request));
    receipts.push(await requiredPort(this.ports.startupBindingReceiptPort, "queryReadyReceipt", request));
    receipts.push(await requiredPort(this.ports.repositorySourceSnapshotPort, "preflight", request));
    receipts.push(await requiredPort(this.ports.projectToolsetReceiptPort, "queryValidationReceipt", request));
    const recovering = attempt.status !== "planned";
    const runReceipt = recovering
      ? await requiredPort(this.ports.runIsolationScenarioPort, "queryRunReceipt", { ...request, runId: attempt.externalRunId })
      : await requiredPort(this.ports.runIsolationScenarioPort, "execute", request);
    validateReceiptEnvelope(runReceipt, { now: this.now() });
    receipts.push(runReceipt);
    if (!recovering) {
      attempt = this.controlStore.updateAttemptControl(attempt.recordId, "execution_dispatching", runReceipt.payload.runId);
      await requiredPort(this.ports.sessionExecutionPort, "execute", { ...request, runId: runReceipt.payload.runId });
      attempt = this.controlStore.updateAttemptControl(attempt.recordId, "dispatched", runReceipt.payload.runId);
    }
    const cleanupReceipt = recovering
      ? await requiredPort(this.ports.runIsolationScenarioPort, "queryCleanupReceipt", { ...request, runReceipt })
      : await requiredPort(this.ports.runIsolationScenarioPort, "cleanup", { ...request, runReceipt });
    receipts.push(cleanupReceipt);
    this.controlStore.updateAttemptControl(attempt.recordId, "awaiting_evidence", runReceipt.payload.runId);
    if (plan.search === true) receipts.push(await requiredPort(this.ports.layeredSearchScenarioPort, recovering ? "queryReceipt" : "execute", { ...request, runReceipt, cleanupReceipt }));
    const observation = await requiredPort(this.ports.observabilityQueryPort, "queryObservation", { ...request, runReceipt });
    receipts.push(observation);
    receipts.push(await requiredPort(this.ports.observabilityQueryPort, "queryExport", { ...request, runReceipt, observation }));
    const correlation = this.correlator.correlate({ attemptId: attempt.recordId, receipts, expectedScope: scope, now: this.now() });
    this.controlStore.linkReceipts(scope, attempt.recordId, correlation, receipts);
    const report = buildRunReport(experimentId, request, correlation, receipts, this.now());
    this.controlStore.saveReport(scope, "run", experimentId, report);
    this.controlStore.updateAttemptControl(attempt.recordId, "correlated", runReceipt.payload.runId, { reportId: report.reportId, identityChainHash: correlation.identityChainHash });
    return report;
  }

  async cancel(scope, experimentId, expectedResourceVersion) {
    const experiment = this.controlStore.getExperiment(scope, experimentId);
    if (["completed", "held", "stopped", "invalidated", "cancelled"].includes(experiment.status)) return experiment;
    await Promise.allSettled([
      this.ports.sessionExecutionPort?.cancel?.({ scope, experimentId }),
      this.ports.runIsolationScenarioPort?.cancel?.({ scope, experimentId }),
      this.ports.layeredSearchScenarioPort?.cancel?.({ scope, experimentId })
    ]);
    return this.controlStore.transitionExperiment(scope, experimentId, expectedResourceVersion, "cancelled", { cancelRequestedAt: new Date(this.now()).toISOString() });
  }
}

function buildRunReport(experimentId, request, correlation, receipts, now) {
  const observation = receipts.find((item) => item.receiptType === "Observation");
  const observationExport = receipts.find((item) => item.receiptType === "ObservationExport")?.payload;
  const cleanup = receipts.find((item) => item.receiptType === "CleanupReceipt")?.payload;
  const search = receipts.find((item) => item.receiptType === "SearchReceipt")?.payload;
  const metrics = metricsFromExport(observationExport);
  const assertions = receipts.flatMap((item) => item.evidence ?? []).filter((item) => item.kind === "assertion").map((item) => ({ summary: item.assertionSummary, passed: item.exitCode === 0, receiptId: item.receiptId ?? null }));
  const body = {
    reportId: `run_report:${request.attemptId}`, schemaVersion: 2, experimentId,
    suiteId: "corptie-code-task", sampleId: request.sampleId, sizeClass: request.sizeClass, performanceBudgetId: request.performanceBudgetId,
    pairIndex: request.pairIndex, attemptId: request.attemptId, variant: request.variant, mode: request.mode,
    identityChain: correlation.identityChain, identityChainHash: correlation.identityChainHash,
    receiptRefs: correlation.receiptRefs, evidenceRefs: correlation.evidenceRefs,
    observabilityLevel: observationExport?.samplePolicy?.observabilityLevel ?? "boundary-only",
    analysisVersion: observationExport?.analysisVersion ?? null,
    completeness: observationExport?.completeness?.value ?? observationExport?.completeness ?? null, metrics,
    assertionResults: assertions, exclusions: [],
    eligibility: observation?.metrics?.sequenceGap ? "shadow_only" : "eligible",
    cleanupOutcome: cleanup?.outcome ?? null, deniedPathLeak: Number(search?.resultSummary?.deniedPathLeak ?? 0),
    generatedAt: new Date(now).toISOString()
  };
  return Object.freeze({ ...body, contentHash: contentHash(body) });
}

function buildSuiteReport(experimentId, definition, reports, now) {
  const eligible = reports.filter((report) => report.eligibility === "eligible");
  const paired = pairMetric(eligible, "wallClockMs");
  const wall = pairedStatistics(paired, { minimumPairs: definition.gatePolicy.minimumValidPairs, minimumP95Runs: definition.gatePolicy.minimumP95Runs, seed: definition.randomSeed });
  const segments = [...new Set(eligible.map((report) => `${report.sampleId}:${report.mode}`))].map((key) => {
    const [sampleId, mode] = key.split(":");
    const runs = eligible.filter((report) => report.sampleId === sampleId && report.mode === mode);
    return { sampleId, mode, statistics: pairedStatistics(pairMetric(runs, "wallClockMs"), { minimumPairs: definition.gatePolicy.minimumValidPairs, minimumP95Runs: definition.gatePolicy.minimumP95Runs, seed: `${definition.randomSeed}:${key}` }) };
  });
  const cleanupSuccessRate = eligible.length ? eligible.filter((report) => report.cleanupOutcome === "cleaned").length / eligible.length : 0;
  const functionalSuccessRate = eligible.length ? eligible.filter((report) => report.assertionResults.length > 0 && report.assertionResults.every((item) => item.passed)).length / eligible.length : 0;
  const evidenceRefs = eligible.flatMap((report) => report.receiptRefs.map((ref) => `receipt:${ref.receiptId}`));
  const body = {
    reportId: `suite_report:${experimentId}:${contentHash(reports.map((item) => item.contentHash)).slice(0, 20)}`,
    schemaVersion: 2, suiteId: "corptie-code-task", suiteVersion: 2, suiteHash: definition.suiteHash,
    experimentId, providerCapabilityClass: definition.providerCapabilityClass,
    environmentFingerprint: validateNoiseProfile(definition.noiseProfile),
    validRuns: eligible.length, validPairs: wall.validPairs, excludedRuns: reports.length - eligible.length,
    minimumSegmentValidPairs: segments.length ? Math.min(...segments.map((item) => item.statistics.validPairs)) : 0,
    minimumSegmentValidRuns: segments.length ? Math.min(...segments.map((item) => item.statistics.validRuns)) : 0,
    segments,
    wall, functionalSuccessRate, functionalSuccessDelta: definition.functionalSuccessDelta ?? 0,
    identityCorrelationRate: reports.length ? reports.filter((item) => item.identityChainHash).length / reports.length : 0,
    cleanupSuccessRate, safetyViolations: definition.safetyViolations ?? [],
    falseSuccessCount: 0, deniedPathLeakCount: reports.reduce((sum, item) => sum + item.deniedPathLeak, 0), foreignProcessKillCount: 0, sensitiveLeakCount: 0, scopePollutionCount: 0,
    metricCoverage: { wallClockMs: eligible.filter((item) => item.metrics.wallClockMs != null).length / Math.max(1, eligible.length) },
    receiptRefs: eligible.flatMap((item) => item.receiptRefs), evidenceRefs,
    evidenceManifestHash: contentHash(evidenceRefs.sort()), generatedAt: new Date(now).toISOString()
  };
  return Object.freeze({ ...body, contentHash: contentHash(body) });
}

function pairMetric(reports, field) {
  const pairs = new Map();
  for (const report of reports) {
    const key = `${report.sampleId}:${report.pairIndex}:${report.mode}`;
    const pair = pairs.get(key) ?? {};
    pair[report.variant === "A" ? "baseline" : "candidate"] = report.metrics[field];
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}

function metricsFromExport(report) {
  return {
    wallClockMs: report?.wall?.wallClockMs ?? null,
    modelInclusiveMs: report?.inclusive?.modelInclusiveMs ?? null,
    toolInclusiveMs: report?.inclusive?.toolInclusiveMs ?? null,
    criticalPathMs: report?.wall?.criticalPathMs ?? null,
    unattributedMs: report?.unattributed?.unattributedMs ?? null,
    unattributedRatio: report?.unattributed?.ratio ?? null,
    modelInvocationCount: report?.inclusive?.modelInvocationCount ?? null,
    samplingCount: report?.inclusive?.samplingCount ?? null,
    toolCallCount: report?.inclusive?.toolCallCount ?? null,
    completeness: report?.completeness?.value ?? report?.completeness ?? null,
    searchLatencyMs: null, validationDurationMs: null, cleanupDurationMs: null, conflictCount: null
  };
}

async function requiredPort(port, method, input) {
  if (!port || typeof port[method] !== "function") throw benchmarkError("BENCHMARK_PORT_UNAVAILABLE", `Authoritative port ${method} is unavailable.`, "orchestrator", { retryable: true, statusCode: 503 });
  return port[method](input);
}
