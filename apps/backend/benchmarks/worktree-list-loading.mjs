import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";

const execFileAsync = promisify(execFile);
const repositoryPath = resolve(process.argv[2] ?? process.cwd());
const repetitions = Math.max(1, Number(process.argv[3]) || 5);
const store = {
  upsertGitWorkspaceSnapshot() {},
  listLogicalSessionsByWorkspaceId() { return []; },
  getSession() { return null; }
};

async function measure(kind, count) {
  const results = [];
  for (let iteration = 0; iteration < count; iteration += 1) {
    const calls = [];
    const observations = [];
    const manager = new GitWorkspaceManager({
      store,
      transitions: {},
      execFile: async (file, args, options) => {
        calls.push(args.slice(2));
        return execFileAsync(file, args, options);
      },
      observePerformance: (entry) => observations.push(entry)
    });
    const startedAt = performance.now();
    const inspection = kind === "management"
      ? await manager.managementInspectionForProject(repositoryPath)
      : await manager.integrationInspectionForProject(repositoryPath);
    results.push({
      totalMs: rounded(performance.now() - startedAt),
      worktreeCount: inspection.worktrees.length,
      postSnapshotGitCalls: summarizeCalls(calls),
      postSnapshotGitCallCount: calls.length,
      observations
    });
  }
  return results;
}

const management = await measure("management", repetitions);
const deep = await measure("deep", 1);
const orderedDurations = management.map((entry) => entry.totalMs).sort((left, right) => left - right);
console.log(JSON.stringify({
  repositoryPath,
  worktreeCount: management[0].worktreeCount,
  managementMs: management.map((entry) => entry.totalMs),
  managementMedianMs: orderedDurations[Math.floor(orderedDurations.length / 2)],
  managementPostSnapshotGitCalls: management[0].postSnapshotGitCalls,
  managementPostSnapshotGitCallCount: management[0].postSnapshotGitCallCount,
  deepMs: deep[0].totalMs,
  deepPostSnapshotGitCalls: deep[0].postSnapshotGitCalls,
  deepPostSnapshotGitCallCount: deep[0].postSnapshotGitCallCount,
  firstManagementObservations: management[0].observations
}, null, 2));

function summarizeCalls(calls) {
  return Object.fromEntries(Object.entries(calls.reduce((summary, args) => {
    const command = args[0];
    summary[command] = (summary[command] ?? 0) + 1;
    return summary;
  }, {})).sort(([left], [right]) => left.localeCompare(right)));
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}
