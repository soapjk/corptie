import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { createGitWorkspaceSnapshot } from "../src/utils/gitWorktreeInventory.mjs";
import { createWorktreeIntegrationServices } from "../src/application/worktreeIntegrationComposition.mjs";

// Entirely local disposable repositories. No product database or Provider calls.
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "corptie-sync-benchmark-"));
const git = async (path, ...args) => (await run("git", ["-C", path, ...args], {
  env: { ...process.env, GIT_AUTHOR_NAME: "Sync benchmark", GIT_COMMITTER_NAME: "Sync benchmark",
    GIT_AUTHOR_EMAIL: "benchmark@corptie.local", GIT_COMMITTER_EMAIL: "benchmark@corptie.local" }
})).stdout.trim();
let store;
const counts = process.env.CORPTIE_SYNC_BENCH_COUNTS?.split(",").map(Number) ?? [1, 3, 10, 30];
const concurrencies = process.env.CORPTIE_SYNC_BENCH_CONCURRENCIES?.split(",").map(Number) ?? [1, 2, 3, 4];
if (!counts.every(value => [1, 3, 10, 30].includes(value)) || !concurrencies.every(value => [1, 2, 3, 4].includes(value))) {
  throw new Error("Benchmark counts must be 1,3,10,30 and concurrency must be 1,2,3,4.");
}
try {
  for (const count of counts) {
    const directory = join(root, String(count));
    const main = join(directory, "main");
    await mkdir(main, { recursive: true });
    await git(main, "init", "-b", "main");
    await git(main, "commit", "--allow-empty", "-m", "base");
    const base = await git(main, "rev-parse", "HEAD");
    await writeFile(join(main, "target.txt"), "target\n");
    await git(main, "add", ".");
    await git(main, "commit", "-m", "target");
    const sources = [];
    for (let index = 0; index < count; index++) {
      const path = join(directory, `source-${index}`);
      await git(main, "worktree", "add", "-b", `source-${index}`, path, base);
      await writeFile(join(path, `source-${index}.txt`), "source\n");
      await git(path, "add", ".");
      await git(path, "commit", "-m", "source");
      sources.push({ path, head: await git(path, "rev-parse", "HEAD") });
    }
    store = new CorptieStore({ dbPath: join(directory, "benchmark.sqlite"), configPath: join(directory, "config.json") });
    await store.initialize();
    const snapshot = await createGitWorkspaceSnapshot(main);
    store.upsertGitWorkspaceSnapshot(snapshot);
    let scans = 0;
    const manager = new GitWorkspaceManager({ store, observePerformance: event => {
      if (event.operation === "integrationInspectionForProject") scans++;
    } });
    const { worktreeIntegrationJobService: jobs } = createWorktreeIntegrationServices({
      store, gitWorkspaces: manager, gitHubPushes: {},
      gitCommitProtection: { inspect: async () => ({ protectedPaths: [], requiresDecision: false }) },
      projectApplicationService: { requireProject: async () => ({ id: snapshot.repository.id, mainPath: main }) },
      workService: {}, emitEvent: () => {}, presentTaskForClient: task => task
    });
    const sourceWorktreeIds = snapshot.worktrees.filter(item => !item.isMain).map(item => item.worktreeId);
    const targetWorktreeId = snapshot.worktrees.find(item => item.isMain).worktreeId;
    for (const concurrency of concurrencies) {
      // Reset only the exact disposable source directories allocated above.
      for (const source of sources) await git(source.path, "reset", "--hard", source.head);
      manager.invalidateInspectionCache(snapshot.repository.id, "benchmark_reset");
      jobs.syncConcurrency = concurrency;
      scans = 0;
      const started = performance.now();
      const plan = await jobs.preflight(snapshot.repository.id, { operationType: "one_way_sync", sourceWorktreeIds, targetWorktreeId });
      await jobs.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
      const deadline = Date.now() + 120000;
      let job;
      do {
        await new Promise(resolve => setTimeout(resolve, 10));
        job = jobs.get(plan.id);
      } while (["queued", "running"].includes(job.status) && Date.now() < deadline);
      if (job.status !== "completed") throw new Error(`Benchmark failed: ${job.status}: ${job.error}`);
      const batch = job.audit.findLast(entry => entry.event === "sync_batch_settled");
      console.log(JSON.stringify({ count, concurrency, totalMs: Math.round(performance.now() - started), rebaseBatchMs: batch.durationMs, inventoryInspections: scans }));
    }
    await store.close();
    store = null;
  }
} finally {
  await store?.close();
  await rm(root, { recursive: true, force: true });
}
