import {
  assertSessionRecoveryPerformanceGates,
  runSessionRecoveryPerformanceBenchmark
} from "../src/application/sessionRecoveryPerformance.mjs";

const report = runSessionRecoveryPerformanceBenchmark({ iterations: Number(process.env.CORPTIE_BENCHMARK_ITERATIONS ?? 30) });
assertSessionRecoveryPerformanceGates(report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
