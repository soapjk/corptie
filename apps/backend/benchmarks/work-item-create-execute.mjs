import { resolve } from "node:path";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { createGitWorkspaceSnapshot } from "../src/utils/gitWorktreeInventory.mjs";
import { WorkItemWorkspaceService } from "../src/application/workItemWorkspaceService.mjs";

const repositoryPath = resolve(process.argv[2] ?? process.cwd());
const workItemId = String(process.argv[3] ?? "").trim();
const repetitions = Math.max(3, Number(process.argv[4]) || 5);
if (!workItemId) {
  throw new Error("Usage: node benchmarks/work-item-create-execute.mjs <repository> <existing-work-item-id> [repetitions]");
}

const initial = await createGitWorkspaceSnapshot(repositoryPath);
const suffix = workItemId
  .replace(/^work[_-]?item:/i, "")
  .replace(/[^a-zA-Z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48) || "work";
const expectedBranch = `workitem/${suffix}`;
if (!initial.worktrees.some((worktree) => worktree.branchName === expectedBranch && worktree.availability === "available")) {
  throw new Error(`Benchmark is read-only and requires an existing available ${expectedBranch} Worktree.`);
}

const store = {
  upsertGitWorkspaceSnapshot() {},
  listLogicalSessionsByWorkspaceId() { return []; },
  getSession() { return null; },
  getLogicalSessionByLegacySessionId() { return null; }
};
const manager = new GitWorkspaceManager({
  store,
  transitions: { switchWorkspace: async () => { throw new Error("Benchmark must not switch Workspaces."); } }
});
const project = { id: initial.repository.id, mainPath: repositoryPath };
const service = new WorkItemWorkspaceService({
  store,
  requireProject: async () => project,
  inspectProject: (path, repositoryId) => manager.projectStatusForPath(path, repositoryId),
  ensureWorktree: (input) => manager.ensureWorkItemWorktreeForProject(input),
  restoreMissingWorktree: (input) => manager.restoreMissingWorktree(input)
});
const workItem = { id: workItemId, main_workspace_id: initial.repository.id };

const samples = [];
for (let iteration = 0; iteration < repetitions; iteration += 1) {
  let startedAt = performance.now();
  await manager.projectStatusForPath(repositoryPath, initial.repository.id);
  await manager.ensureWorkItemWorktreeForProject({
    repositoryId: initial.repository.id,
    workingDirectory: repositoryPath,
    workItemId
  });
  const legacyMs = rounded(performance.now() - startedAt);

  startedAt = performance.now();
  await service.ensure({ workItem });
  const optimizedMs = rounded(performance.now() - startedAt);
  samples.push({ legacyMs, optimizedMs });
}

const legacyMedianMs = median(samples.map((sample) => sample.legacyMs));
const optimizedMedianMs = median(samples.map((sample) => sample.optimizedMs));
console.log(JSON.stringify({
  repositoryPath,
  workItemId,
  worktreeCount: initial.worktrees.length,
  samples,
  legacyMedianMs,
  optimizedMedianMs,
  reductionMs: rounded(legacyMedianMs - optimizedMedianMs),
  reductionPercent: rounded((legacyMedianMs - optimizedMedianMs) / legacyMedianMs * 100)
}, null, 2));

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}
