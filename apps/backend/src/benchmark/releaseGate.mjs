import { benchmarkError, contentHash } from "./canonical.mjs";

export const DEFAULT_GATE_POLICY = Object.freeze({
  gatePolicyId: "corptie-code-task-v1", version: 1,
  minimumValidPairs: 30, minimumP95Runs: 100,
  minimumIdentityCorrelation: 0.995, minimumCompletenessP50: 0.95,
  maximumWallP95Ratio: 1.05, maximumWallOverheadRatio: 1.03, maximumWallOverheadMs: 150,
  maximumUnattributedIncrease: 0.02, nonInferiorityMargin: -0.005,
  cleanupSuccessMinimum: 0.999, immediateCleanupStopBelow: 0.99
});

export class ReleaseGate {
  evaluate({ report, policy = DEFAULT_GATE_POLICY, prerequisiteDecisionRefs = [], killSwitchReceipt, stage = "shadow", cohortRef = null, now = Date.now() }) {
    if (!report || report.schemaVersion !== 2 || report.contentHash !== contentHash(omit(report, "contentHash"))) throw benchmarkError("BENCHMARK_EVIDENCE_NOT_REPRODUCIBLE", "Suite report hash is invalid.", "gate");
    const criterionResults = [];
    const missingEvidence = [];
    const safetyViolations = [...(report.safetyViolations ?? [])];
    if (!killSwitchReceipt?.receiptId || typeof killSwitchReceipt.active !== "boolean") missingEvidence.push("killSwitchReceipt");
    if (killSwitchReceipt?.active) safetyViolations.push("kill-switch-active");
    if (!Array.isArray(report.receiptRefs) || report.receiptRefs.length === 0) missingEvidence.push("authority-receipts");
    add(criterionResults, "identity-correlation", policy.minimumIdentityCorrelation, report.identityCorrelationRate, report.identityCorrelationRate >= policy.minimumIdentityCorrelation, report.evidenceRefs);
    add(criterionResults, "valid-pairs", policy.minimumValidPairs, report.validPairs, report.validPairs >= policy.minimumValidPairs, report.evidenceRefs);
    add(criterionResults, "p95-runs", policy.minimumP95Runs, report.validRuns, report.validRuns >= policy.minimumP95Runs, report.evidenceRefs);
    add(criterionResults, "minimum-stage-pairs", policy.minimumValidPairs, report.minimumSegmentValidPairs, report.minimumSegmentValidPairs >= policy.minimumValidPairs, report.evidenceRefs);
    add(criterionResults, "minimum-stage-p95-runs", policy.minimumP95Runs, report.minimumSegmentValidRuns, report.minimumSegmentValidRuns >= policy.minimumP95Runs, report.evidenceRefs);
    add(criterionResults, "functional-success-non-inferiority", policy.nonInferiorityMargin, report.functionalSuccessDelta, report.functionalSuccessDelta >= policy.nonInferiorityMargin, report.evidenceRefs);
    add(criterionResults, "cleanup-success", policy.cleanupSuccessMinimum, report.cleanupSuccessRate, report.cleanupSuccessRate >= policy.cleanupSuccessMinimum, report.evidenceRefs);
    if (report.wall?.ratio?.p95 != null) add(criterionResults, "wall-p95-ratio", policy.maximumWallP95Ratio, report.wall.ratio.p95, report.wall.ratio.p95 <= policy.maximumWallP95Ratio, report.evidenceRefs);
    else missingEvidence.push("wall-p95");
    const hardSafety = safetyViolations.length > 0 || report.falseSuccessCount > 0 || report.deniedPathLeakCount > 0 || report.foreignProcessKillCount > 0 || report.sensitiveLeakCount > 0 || report.scopePollutionCount > 0;
    let action = "promote";
    if (hardSafety) action = "kill_requested";
    else if (report.cleanupSuccessRate < policy.immediateCleanupStopBelow || criterionResults.some((item) => item.verdict === "failed" && !["valid-pairs", "p95-runs", "minimum-stage-pairs", "minimum-stage-p95-runs"].includes(item.criterionId))) action = "stop";
    else if (missingEvidence.length > 0 || criterionResults.some((item) => item.verdict !== "passed")) action = "hold";
    const body = {
      decisionId: `gate:${report.reportId}:${contentHash({ reportHash: report.contentHash, policy, stage, cohortRef }).slice(0, 20)}`,
      schemaVersion: 1, stage, providerCapabilityClass: report.providerCapabilityClass, cohortRef, action,
      criterionResults, missingEvidence, safetyViolations,
      sampleAdequacy: { validPairs: report.validPairs, validRuns: report.validRuns, minimumSegmentValidPairs: report.minimumSegmentValidPairs, minimumSegmentValidRuns: report.minimumSegmentValidRuns, adequate: report.minimumSegmentValidPairs >= policy.minimumValidPairs && report.minimumSegmentValidRuns >= policy.minimumP95Runs },
      policyHash: contentHash(policy), reportHash: report.contentHash, prerequisiteDecisionRefs,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(), supersedesDecisionId: null
    };
    return Object.freeze({ ...body, contentHash: contentHash(body) });
  }

  evaluateFailure({ experimentId, providerCapabilityClass, stage = "shadow", error, evidenceRefs = [], now = Date.now() }) {
    const killCodes = new Set(["BENCHMARK_RECEIPT_HASH_INVALID", "BENCHMARK_RECEIPT_PRODUCER_FORBIDDEN", "BENCHMARK_SOURCE_FINGERPRINT_MISMATCH", "BENCHMARK_SCOPE_MISMATCH", "BENCHMARK_EVIDENCE_NOT_REPRODUCIBLE"]);
    const stopCodes = new Set(["BENCHMARK_IDENTITY_CHAIN_MISMATCH", "BENCHMARK_RUN_CLEANUP_MISMATCH", "BENCHMARK_STAGE_FIELD_FORBIDDEN"]);
    const action = killCodes.has(error?.code) ? "kill_requested" : stopCodes.has(error?.code) ? "stop" : "hold";
    const body = {
      decisionId: `gate_failure:${experimentId}:${contentHash({ code: error?.code, stage, evidenceRefs }).slice(0, 20)}`,
      schemaVersion: 1, stage, providerCapabilityClass, cohortRef: null, action,
      criterionResults: [{ criterionId: "fail-closed-evidence", threshold: "valid-authority-evidence", actual: error?.code ?? "BENCHMARK_INTERNAL_ERROR", verdict: "failed", evidenceRefs }],
      missingEvidence: action === "hold" ? ["recoverable-authority-evidence"] : [],
      safetyViolations: action === "kill_requested" ? [error?.code ?? "BENCHMARK_INTERNAL_ERROR"] : [],
      sampleAdequacy: { validPairs: 0, validRuns: 0, minimumSegmentValidPairs: 0, minimumSegmentValidRuns: 0, adequate: false },
      policyHash: contentHash(DEFAULT_GATE_POLICY), reportHash: `failure:${contentHash({ code: error?.code, evidenceRefs })}`,
      prerequisiteDecisionRefs: [], issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(), supersedesDecisionId: null
    };
    return Object.freeze({ ...body, contentHash: contentHash(body) });
  }
}

function add(items, criterionId, threshold, actual, passed, evidenceRefs = []) { items.push({ criterionId, threshold, actual: actual ?? null, verdict: actual == null ? "unknown" : passed ? "passed" : "failed", evidenceRefs: [...(evidenceRefs ?? [])] }); }
function omit(value, field) { const copy = { ...value }; delete copy[field]; return copy; }
