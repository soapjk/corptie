import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSessionRecoveryPerformanceGates,
  runSessionRecoveryPerformanceBenchmark
} from "../src/application/sessionRecoveryPerformance.mjs";

test("short, medium, and long Session recovery benchmarks stay within fixed regression gates", () => {
  const report = runSessionRecoveryPerformanceBenchmark({ iterations: 30 });
  assert.equal(report.tiers.short.turnCount, 16);
  assert.equal(report.tiers.medium.turnCount, 150);
  assert.equal(report.tiers.long.itemCount, 650);
  assert.ok(report.tiers.long.checkpointCompressionRatio < 0.25);
  assert.equal(report.tiers.long.actualInputTokens, null);
  assert.equal(report.tiers.long.firstTokenLatencyMs, null);
  assert.equal(assertSessionRecoveryPerformanceGates(report), true);
});
