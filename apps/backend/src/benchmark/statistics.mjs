import { assertClosedObject, benchmarkError, contentHash } from "./canonical.mjs";

export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.map(finite).sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.map(finite).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function pairedStatistics(pairs, options = {}) {
  const valid = pairs.filter((pair) => pair && Number.isFinite(pair.baseline) && Number.isFinite(pair.candidate));
  const minimumPairs = options.minimumPairs ?? 30;
  const minimumP95Runs = options.minimumP95Runs ?? 100;
  const deltas = valid.map((pair) => pair.candidate - pair.baseline);
  const ratios = valid.map((pair) => pair.baseline === 0 ? null : pair.candidate / pair.baseline).filter(Number.isFinite);
  const baseline = valid.map((pair) => pair.baseline);
  const candidate = valid.map((pair) => pair.candidate);
  const adequatePairs = valid.length >= minimumPairs;
  const adequateP95 = valid.length * 2 >= minimumP95Runs;
  return {
    validPairs: valid.length,
    validRuns: valid.length * 2,
    adequatePairs,
    adequateP95,
    baseline: { p50: median(baseline), p95: adequateP95 ? nearestRank(baseline, 0.95) : null },
    candidate: { p50: median(candidate), p95: adequateP95 ? nearestRank(candidate, 0.95) : null },
    delta: { p50: median(deltas), p95: adequateP95 ? nearestRank(deltas, 0.95) : null },
    ratio: { p50: median(ratios), p95: adequateP95 ? nearestRank(ratios, 0.95) : null },
    bootstrap95CI: adequatePairs ? bootstrapMedianCI(deltas, options.bootstrapIterations ?? 2_000, options.seed ?? "corptie-benchmark-v1") : null
  };
}

export function bootstrapMedianCI(values, iterations, seed) {
  if (!values.length) return null;
  const random = seededRandom(seed);
  const estimates = [];
  for (let index = 0; index < iterations; index += 1) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
    estimates.push(median(sample));
  }
  estimates.sort((a, b) => a - b);
  return { lower: nearestRank(estimates, 0.025), upper: nearestRank(estimates, 0.975), iterations, seed };
}

export function alternatingPairPlan(count, seed = "corptie-ab-v1") {
  if (!Number.isInteger(count) || count < 1) throw benchmarkError("BENCHMARK_PLAN_INVALID", "Pair count must be positive.", "plan");
  const offset = parseInt(contentHash(seed).slice(0, 2), 16) % 2;
  return Array.from({ length: count }, (_, index) => ({ pairIndex: index, order: (index + offset) % 2 === 0 ? "AB" : "BA" }));
}

export function validateNoiseProfile(profile) {
  const fields = ["machineClass", "osBuild", "cpuArchitecture", "memoryClass", "powerState", "thermalState", "filesystemClass", "providerCapabilityClass", "observabilityLevel"];
  assertClosedObject(profile, fields, "BenchmarkNoiseProfile");
  for (const field of fields) if (typeof profile?.[field] !== "string" || !profile[field]) throw benchmarkError("BENCHMARK_NOISE_PROFILE_INVALID", `Noise profile is missing ${field}.`, "statistics");
  return contentHash(Object.fromEntries(fields.map((field) => [field, profile[field]])));
}

function finite(value) {
  if (!Number.isFinite(value)) throw benchmarkError("BENCHMARK_METRIC_INVALID", "Metric must be finite.", "statistics");
  return value;
}

function seededRandom(seed) {
  let state = parseInt(contentHash(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
