import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectGitWorkspace } from "../src/utils/gitWorktreeInventory.mjs";
import { signReceipt } from "../src/project-code/projectCodeContracts.mjs";
import { ProjectCodeSearchApplicationService } from "../src/project-code/projectCodeApplicationService.mjs";
import {
  closeProjectCodeQueryConnections,
  ProjectCodeIndexStore
} from "../src/project-code/projectCodeIndexStore.mjs";
import {
  PROJECT_CODE_MODEL_RECOMMENDATION_ENABLED
} from "../src/project-code/projectCodeDynamicTools.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sampleCount = integerArgument("--samples", 30, 20, 200);
const queries = valuesArgument("--query", [
  "ProjectCodeIndexStore",
  "createValidatedSnapshotLease",
  "getLatestProjectCodeSnapshot"
]);
const benchmarkParent = process.env.CORPTIE_PROJECT_CODE_BENCHMARK_ROOT
  ?? (process.platform === "darwin" ? "/Volumes/T9/CorptieData/project-code-benchmarks" : tmpdir());
await mkdir(benchmarkParent, { recursive: true });
const dataRoot = await mkdtemp(join(benchmarkParent, "run-"));

try {
  const identity = await inspectGitWorkspace(repositoryRoot);
  const [commitOid, treeOid] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["rev-parse", "HEAD^{tree}"])
  ]);
  const sessionContext = Object.freeze({
    workId: "work:11111111-1111-1111-1111-111111111111",
    taskId: "task:benchmark",
    logicalSessionId: "logical:benchmark"
  });
  const binding = Object.freeze({
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    canonicalWorktreePath: identity.canonicalPath,
    providerBindingId: "provider_binding:benchmark",
    bindingGeneration: 1,
    repositoryInventoryVersion: "inventory:benchmark",
    workspaceResourceVersion: 1,
    resourceVersion: 1
  });
  const startupReceipt = createStartupReceipt({ identity, commitOid, treeOid, sessionContext, binding });
  const receipts = new Map();
  const store = benchmarkStore({ binding, sessionContext, receipts });
  const snapshotBuilder = new RepositorySourceSnapshotBuilder();
  const indexStore = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
  const searchService = new ProjectCodeSearchService({ snapshotBuilder, indexStore });
  const application = new ProjectCodeSearchApplicationService({
    store,
    startupReceipts: { require: () => startupReceipt },
    snapshotBuilder,
    searchService
  });

  let started = performance.now();
  const snapshot = await application.createSnapshot({ logicalSessionId: sessionContext.logicalSessionId });
  const snapshotMs = performance.now() - started;
  started = performance.now();
  await application.search(searchInput(sessionContext.logicalSessionId, queries[0]));
  const coldFirstSearchMs = performance.now() - started;
  const measurements = {};
  for (const query of queries) {
    for (let index = 0; index < 5; index += 1) {
      await application.search(searchInput(sessionContext.logicalSessionId, query));
      await rg(query);
    }
    const projectCode = [];
    const ripgrep = [];
    for (let index = 0; index < sampleCount; index += 1) {
      started = performance.now();
      await application.search(searchInput(sessionContext.logicalSessionId, query));
      projectCode.push(performance.now() - started);
      started = performance.now();
      await rg(query);
      ripgrep.push(performance.now() - started);
    }
    measurements[query] = {
      projectCodeMs: statistics(projectCode),
      ripgrepMs: statistics(ripgrep)
    };
  }
  const fasterP50 = Object.values(measurements).every((value) => value.projectCodeMs.p50 < value.ripgrepMs.p50);
  const fasterP95 = Object.values(measurements).every((value) => value.projectCodeMs.p95 < value.ripgrepMs.p95);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    repositoryRoot,
    sampleCount,
    snapshotReceiptId: snapshot.receipt.receiptId,
    snapshotMs: rounded(snapshotMs),
    coldFirstSearchMs: rounded(coldFirstSearchMs),
    indexStats: indexStore.stats,
    measurements,
    comparison: {
      fasterP50ForEveryQuery: fasterP50,
      fasterP95ForEveryQuery: fasterP95,
      singleRunRecommendationGatePassed: fasterP50 && fasterP95,
      modelRecommendationEnabled: PROJECT_CODE_MODEL_RECOMMENDATION_ENABLED
    }
  }, null, 2)}\n`);
} finally {
  closeProjectCodeQueryConnections();
  await rm(dataRoot, { recursive: true, force: true });
}

function searchInput(logicalSessionId, query) {
  return { logicalSessionId, snapshotPolicy: "reuse_current", responseDetail: "compact", query, mode: "symbols" };
}

async function git(args) {
  return (await execFileAsync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

async function rg(query) {
  try {
    await execFileAsync("rg", ["-F", "-n", "--", query, "."], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
}

function createStartupReceipt({ identity, commitOid, treeOid, sessionContext, binding }) {
  const now = new Date().toISOString();
  return signReceipt({
    schemaVersion: 2,
    status: "ready",
    startupOperationId: "startup:benchmark",
    ...sessionContext,
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    canonicalWorktreePath: identity.canonicalPath,
    headIdentity: { kind: "branch", branch: identity.branch ?? "HEAD" },
    providerBindingId: binding.providerBindingId,
    bindingGeneration: binding.bindingGeneration,
    sourceCommitOid: commitOid,
    sourceTreeOid: treeOid,
    baseRef: "HEAD",
    repositoryInventoryVersion: binding.repositoryInventoryVersion,
    workspaceResourceVersion: binding.workspaceResourceVersion,
    resourceVersion: binding.resourceVersion,
    providerContextHash: "a".repeat(64),
    toolContractHash: "b".repeat(64),
    instructionSourcesHash: "c".repeat(64),
    phaseTimestamps: {
      allocatedAt: now,
      worktreePreparedAt: now,
      sessionBoundAt: now,
      providerBoundAt: now,
      readyAt: now
    },
    compensation: { attempted: false, result: "not_required", completedSteps: [], failedStep: null },
    error: null
  });
}

function benchmarkStore({ binding, sessionContext, receipts }) {
  return {
    assertLogicalWorkSessionBinding: () => ({ ...sessionContext, sessionId: "session:benchmark" }),
    getLogicalSession: () => ({ activeBinding: { worktreeId: binding.worktreeId, boundCwd: binding.canonicalWorktreePath } }),
    getSession: () => ({ id: "session:benchmark", sessionKind: "worker" }),
    getTask: () => ({ id: sessionContext.taskId }),
    putProjectCodeReceipt(record) {
      receipts.set(record.receiptId, { ...record });
      return record;
    },
    getProjectCodeReceipt(receiptId, logicalSessionId) {
      const record = receipts.get(receiptId);
      return record?.logicalSessionId === logicalSessionId ? record : null;
    },
    getLatestProjectCodeSnapshot(logicalSessionId) {
      return [...receipts.values()].reverse().find((record) => record.logicalSessionId === logicalSessionId
        && record.receiptType === "RepositorySourceSnapshotReceipt") ?? null;
    }
  };
}

function statistics(values) {
  return {
    p50: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    minimum: rounded(Math.min(...values))
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function integerArgument(name, fallback, minimum, maximum) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function valuesArgument(name, fallback) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values.length > 0 ? values : fallback;
}
