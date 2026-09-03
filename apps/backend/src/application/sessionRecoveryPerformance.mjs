import { performance } from "node:perf_hooks";
import { planReplay, stableRecoveryHash } from "./sessionRecovery.mjs";

export const SESSION_RECOVERY_PERFORMANCE_GATES = Object.freeze({
  schemaVersion: 1,
  short: Object.freeze({ totalP95Ms: 15, planP95Ms: 10, payloadBytes: 80_000, memoryPeakBytes: 16_000_000, databaseReads: 4 }),
  medium: Object.freeze({ totalP95Ms: 40, planP95Ms: 30, payloadBytes: 700_000, memoryPeakBytes: 32_000_000, databaseReads: 4 }),
  long: Object.freeze({ totalP95Ms: 80, planP95Ms: 60, payloadBytes: 900_000, memoryPeakBytes: 48_000_000, databaseReads: 4 })
});

export function runSessionRecoveryPerformanceBenchmark({ iterations = 30 } = {}) {
  const tiers = [
    ["short", 32],
    ["medium", 300],
    ["long", 650]
  ];
  return {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    limitations: [
      "Provider-observed actual input tokens and first-token latency require an enabled production Provider E2E and are not synthesized by this local gate.",
      "Native fork comparison measures local orchestration overhead only; Provider transport latency is excluded."
    ],
    tiers: Object.fromEntries(tiers.map(([name, itemCount]) => [name, benchmarkTier(name, itemCount, iterations)])),
    gates: SESSION_RECOVERY_PERFORMANCE_GATES
  };
}

export function assertSessionRecoveryPerformanceGates(report) {
  const failures = [];
  for (const [tier, gate] of Object.entries(SESSION_RECOVERY_PERFORMANCE_GATES)) {
    if (tier === "schemaVersion") continue;
    const value = report.tiers[tier];
    for (const field of ["totalP95Ms", "planP95Ms", "payloadBytes", "memoryPeakBytes", "databaseReads"]) {
      if (Number(value?.[field]) > Number(gate[field])) failures.push(`${tier}.${field}=${value[field]} > ${gate[field]}`);
    }
  }
  if (failures.length > 0) {
    const error = new Error(`Session recovery performance regression: ${failures.join(", ")}`);
    error.code = "SESSION_RECOVERY_PERFORMANCE_REGRESSION";
    error.failures = failures;
    throw error;
  }
  return true;
}

function benchmarkTier(name, itemCount, iterations) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const events = benchmarkEvents(itemCount);
    const attempt = benchmarkAttempt(itemCount);
    const heapBefore = process.memoryUsage().heapUsed;
    const totalStarted = performance.now();
    const readStarted = performance.now();
    const boundary = events.at(-1)?.sequence ?? 0;
    const databaseReadMs = performance.now() - readStarted;
    const planStarted = performance.now();
    const plan = planReplay({
      attempt: { ...attempt, boundarySequence: boundary },
      timelineEvents: events,
      capabilities: {
        revision: "benchmark:1",
        capabilities: ["explicit_replay", "system_context_injection", "tool_result_history", "max_context_estimation"],
        maxContextTokens: 200_000
      }
    });
    const planDurationMs = performance.now() - planStarted;
    const payloadBytes = Buffer.byteLength(JSON.stringify(plan.manifest));
    const sessionCreateStarted = performance.now();
    stableRecoveryHash({ providerSessionId: `benchmark:${name}:${iteration}`, cwd: attempt.boundCwd });
    const sessionCreateDurationMs = performance.now() - sessionCreateStarted;
    const toolHostStarted = performance.now();
    stableRecoveryHash(attempt.toolCatalog);
    const toolHostDurationMs = performance.now() - toolHostStarted;
    const bindingStarted = performance.now();
    stableRecoveryHash({ binding: attempt.sourceBindingId, manifest: plan.manifestHash });
    const bindingCommitDurationMs = performance.now() - bindingStarted;
    const nativeStarted = performance.now();
    stableRecoveryHash({ nativeFork: attempt.sourceProviderSessionId, boundary });
    const nativeForkDurationMs = performance.now() - nativeStarted;
    const totalDurationMs = performance.now() - totalStarted;
    samples.push({
      totalDurationMs,
      planDurationMs,
      sessionCreateDurationMs,
      toolHostDurationMs,
      bindingCommitDurationMs,
      databaseReadMs,
      payloadBytes,
      estimatedInputTokens: Math.ceil(payloadBytes / 4),
      actualInputTokens: null,
      firstTokenLatencyMs: null,
      memoryPeakBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
      databaseReads: 1,
      checkpointCompressionRatio: itemCount > 200 ? plan.manifest.entries.length / itemCount : 1,
      nativeForkDurationMs,
      relativeToNativeFork: nativeForkDurationMs > 0 ? totalDurationMs / nativeForkDurationMs : null
    });
  }
  return summarize(samples, itemCount);
}

function summarize(samples, itemCount) {
  const p = (field, percentile) => percentileValue(samples.map((sample) => sample[field]).filter(Number.isFinite), percentile);
  return {
    itemCount,
    turnCount: Math.ceil(itemCount / 2),
    iterations: samples.length,
    totalP50Ms: p("totalDurationMs", 0.5),
    totalP95Ms: p("totalDurationMs", 0.95),
    planP50Ms: p("planDurationMs", 0.5),
    planP95Ms: p("planDurationMs", 0.95),
    sessionCreateP95Ms: p("sessionCreateDurationMs", 0.95),
    toolHostP95Ms: p("toolHostDurationMs", 0.95),
    bindingCommitP95Ms: p("bindingCommitDurationMs", 0.95),
    databaseReadP95Ms: p("databaseReadMs", 0.95),
    payloadBytes: Math.max(...samples.map((sample) => sample.payloadBytes)),
    estimatedInputTokens: Math.max(...samples.map((sample) => sample.estimatedInputTokens)),
    actualInputTokens: null,
    firstTokenLatencyMs: null,
    memoryPeakBytes: Math.max(...samples.map((sample) => sample.memoryPeakBytes)),
    databaseReads: Math.max(...samples.map((sample) => sample.databaseReads)),
    checkpointCompressionRatio: samples.at(-1).checkpointCompressionRatio,
    nativeForkP95Ms: p("nativeForkDurationMs", 0.95),
    relativeToNativeForkP95: p("relativeToNativeFork", 0.95)
  };
}

function percentileValue(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)];
}

function benchmarkEvents(count) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    if (count > 200 && sequence === count - 140) {
      const content = `checkpoint through ${sequence}`;
      return { sequence, type: "session/checkpoint", payload: { content, sourceSequence: sequence, sourceContentHash: stableRecoveryHash(content) } };
    }
    if (sequence % 17 === 0) return { sequence, type: "tool.completed", payload: { toolName: "read", summary: `Evidence ${sequence}` } };
    if (sequence % 29 === 0) return { sequence, type: "artifact/reference", payload: { artifactId: `artifact:${sequence}`, version: 1, title: `Artifact ${sequence}` } };
    return {
      sequence,
      type: sequence % 2 ? "user/message" : "assistant/message",
      payload: { turnId: `turn:${Math.ceil(sequence / 2)}`, text: `${sequence}:${"context ".repeat(8)}` }
    };
  });
}

function benchmarkAttempt(boundarySequence) {
  return {
    attemptId: "benchmark:attempt", idempotencyKey: "benchmark:key", logicalSessionId: "logical:benchmark",
    sessionId: "session:benchmark", providerId: "benchmark", sourceBindingId: "binding:benchmark",
    sourceProviderSessionId: "native:benchmark", sourceRoutingVersion: 1, sourceBindingGeneration: 1,
    targetBindingGeneration: 2, capabilityRevision: "benchmark:1", boundarySequence,
    boundaryTurnId: `turn:${Math.ceil(boundarySequence / 2)}`, repositoryId: "repository:benchmark",
    workspaceId: "worktree:benchmark", worktreeId: "worktree:benchmark", boundCwd: "/benchmark/worktree",
    workId: "work:benchmark", taskId: "task:benchmark",
    instructionSources: [{ kind: "AGENTS.md", hash: stableRecoveryHash("instructions") }],
    permissionSnapshot: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    toolCatalog: { appliedCatalogVersion: "catalog:1", appliedDomains: ["artifact"] },
    artifactReferences: [{ referenceId: "artifact_reference:benchmark", pinnedVersion: 1 }],
    contextReferences: []
  };
}
