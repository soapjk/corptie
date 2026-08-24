import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { inspectGitWorkspace } from "../src/utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);
const repositoryPath = resolve(process.argv[2] ?? process.cwd());
const clientCount = Math.max(1, Number(process.argv[3]) || 4);
const repositoryId = (await inspectGitWorkspace(repositoryPath)).repositoryId;

async function scenario(name, forceFresh) {
  let gitSubprocessCount = 0;
  let snapshotWriteCount = 0;
  let lastInventoryVersion = null;
  const observations = [];
  const store = {
    upsertGitWorkspaceSnapshot(snapshot) {
      if (forceFresh || snapshot.inventoryVersion !== lastInventoryVersion) {
        snapshotWriteCount += 1;
        lastInventoryVersion = snapshot.inventoryVersion;
      }
    },
    listLogicalSessionsByWorkspaceId() { return []; },
    getSession() { return null; },
    listGitRepositories() { return []; }
  };
  const manager = new GitWorkspaceManager({
    store,
    transitions: {},
    inspectionCacheTtlMs: 5_000,
    execFile: async (file, args, options) => {
      gitSubprocessCount += 1;
      return execFileAsync(file, args, options);
    },
    observePerformance: (entry) => observations.push(entry)
  });
  const cpuBefore = process.cpuUsage();
  const wallStartedAt = performance.now();
  const requests = Array.from({ length: clientCount }, async () => {
    const startedAt = performance.now();
    await manager.projectStatusForPath(repositoryPath, repositoryId, {
      inspectionLevel: "management",
      forceFresh,
      includeDiffStat: false,
      reason: name
    });
    return performance.now() - startedAt;
  });
  const durations = await Promise.all(requests);
  const cpu = process.cpuUsage(cpuBefore);
  return {
    name,
    clientCount,
    wallMs: rounded(performance.now() - wallStartedAt),
    totalRequestMs: rounded(durations.reduce((sum, value) => sum + value, 0)),
    p95RequestMs: rounded(percentile(durations, 0.95)),
    gitSubprocessCount,
    snapshotWriteCount,
    cpuMs: rounded((cpu.user + cpu.system) / 1_000),
    inspection: manager.inspectionPerformanceSnapshot(),
    observations
  };
}

const baseline = await scenario("baseline_no_sharing", true);
const optimized = await scenario("optimized_shared_window", false);
console.log(JSON.stringify({
  repositoryPath,
  repositoryId,
  baseline,
  optimized,
  reductions: {
    actualScansPercent: percentReduction(baseline.inspection.scans, optimized.inspection.scans),
    gitSubprocessPercent: percentReduction(baseline.gitSubprocessCount, optimized.gitSubprocessCount),
    cpuPercent: percentReduction(baseline.cpuMs, optimized.cpuMs),
    idlePollFrequencyPercent: rounded((1 - (5 / 60)) * 100),
    projectedIdleActualScansPercent: percentReduction(
      baseline.inspection.scans * 12,
      optimized.inspection.scans
    ),
    projectedIdleGitSubprocessPercent: percentReduction(
      baseline.gitSubprocessCount * 12,
      optimized.gitSubprocessCount
    )
  },
  projectedIdlePerMinute: {
    baselineScans: baseline.inspection.scans * 12,
    optimizedScans: optimized.inspection.scans,
    baselineGitSubprocesses: baseline.gitSubprocessCount * 12,
    optimizedGitSubprocesses: optimized.gitSubprocessCount,
    baselineAverageCpuPercent: rounded((baseline.cpuMs * 12 / 60_000) * 100),
    optimizedAverageCpuPercent: rounded((optimized.cpuMs / 60_000) * 100)
  }
}, null, 2));

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function percentReduction(before, after) {
  return before === 0 ? 0 : rounded((1 - after / before) * 100);
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}
