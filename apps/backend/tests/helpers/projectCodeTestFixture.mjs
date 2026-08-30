import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { inspectGitWorkspace } from "../../src/utils/gitWorktreeInventory.mjs";
import {
  RUN_RECEIPT_ARTIFACT,
  signReceipt,
  runStartupBindingReceiptRef,
  snapshotReceiptRef,
  startupBindingRef
} from "../../src/project-code/projectCodeContracts.mjs";
import { ProjectCodeRunIsolationPort } from "../../src/project-code/projectCodeRunIsolationPort.mjs";

const execFileAsync = promisify(execFile);

export async function createProjectCodeFixture(options = {}) {
  const directory = await mkdtemp(join(options.parent ?? tmpdir(), "corptie-project-code-"));
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "tests@corptie.local"]);
  await git(directory, ["config", "user.name", "Corptie Tests"]);
  const files = options.files ?? {
    "Sources/App.swift": "struct SearchFixture {\n  func exactNeedle() {}\n}\n",
    "Sources/tool.ts": "export function layeredSymbol() { return 'needle'; }\n",
    ".gitignore": "ignored/\n.build/\n"
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-qm", "fixture"]);
  const identity = await inspectGitWorkspace(directory);
  const [commitOid, treeOid] = await Promise.all([
    git(directory, ["rev-parse", "HEAD"]), git(directory, ["rev-parse", "HEAD^{tree}"])
  ]);
  const sessionContext = {
    objectiveId: "objective:test", workItemId: "work_item:test", logicalSessionId: "logical:test"
  };
  const binding = {
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    canonicalWorktreePath: identity.canonicalPath,
    providerBindingId: "provider_binding:test",
    bindingGeneration: 1,
    repositoryInventoryVersion: "inventory:test",
    workspaceResourceVersion: 1,
    resourceVersion: 1
  };
  const startupReceipt = startupReceiptFor({ identity, commitOid, treeOid, sessionContext, binding });
  return { directory, identity, commitOid, treeOid, sessionContext, binding, startupReceipt };
}

export function startupReceiptFor({ identity, commitOid, treeOid, sessionContext, binding }) {
  const now = "2026-08-30T00:00:00.000Z";
  return signReceipt({
    schemaVersion: 2,
    status: "ready",
    startupOperationId: "startup:test",
    ...sessionContext,
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    canonicalWorktreePath: identity.canonicalPath,
    headIdentity: { kind: "branch", branch: "master" },
    providerBindingId: binding.providerBindingId,
    bindingGeneration: binding.bindingGeneration,
    sourceCommitOid: commitOid,
    sourceTreeOid: treeOid,
    baseRef: "HEAD",
    repositoryInventoryVersion: binding.repositoryInventoryVersion,
    workspaceResourceVersion: binding.workspaceResourceVersion,
    resourceVersion: binding.resourceVersion,
    providerContextHash: "a".repeat(64),
    phaseTimestamps: { allocatedAt: now, worktreePreparedAt: now, sessionBoundAt: now, providerBoundAt: now, readyAt: now },
    compensation: { attempted: false, result: "not_required", completedSteps: [], failedStep: null },
    error: null
  });
}

export function toolsetReceiptFor(snapshot, overrides = {}) {
  const now = "2026-08-30T00:00:00.000Z";
  return signReceipt({
    receiptId: overrides.receiptId ?? "toolset_validation_receipt:test",
    schemaVersion: 2,
    resourceVersion: 1,
    artifactRef: {
      artifactId: "artifact:172b9f2e-a2d1-451c-a3e4-d52ba3d95850",
      version: 1,
      contentHash: "c203f2fd99d24064c46ab46e17f016a9494d643ab2b64e95c3f363fc8af00e62"
    },
    identity: {
      logicalSessionId: "logical:test",
      objectiveId: "objective:11111111-1111-1111-1111-111111111111",
      workItemId: "work_item:test",
      repositoryId: snapshot.receipt.repositoryId,
      worktreeId: snapshot.receipt.worktreeId,
      startupBindingRef: startupBindingRef(snapshot.startupReceipt)
    },
    snapshotRef: overrides.snapshotRef ?? snapshotReceiptRef(snapshot.receipt),
    toolsetVersion: `ptv1:${"1".repeat(64)}`,
    validationPlanIdentity: `vp1:${"2".repeat(64)}`,
    validationCacheKey: `tvck1:${"3".repeat(64)}`,
    actionReceipts: [],
    assertionReceipts: [],
    cacheDisposition: "stored",
    outcome: "passed",
    startedAt: now,
    finishedAt: now,
    expiresAt: null,
    error: null
  });
}

export function formalRunIsolationPort(snapshot, sessionContext, options = {}) {
  const runId = options.runId ?? "run:semantic-test";
  const calls = options.calls ?? [];
  const now = "2026-08-30T00:00:00.000Z";
  const context = {
    runId,
    logicalSessionId: sessionContext.logicalSessionId,
    workItemId: sessionContext.workItemId,
    repositoryId: snapshot.receipt.repositoryId,
    worktreeId: snapshot.receipt.worktreeId,
    sourceFingerprint: snapshot.receipt.sourceFingerprint,
    resourceVersion: 1,
    fencingToken: 7
  };
  let runReceipt;
  const service = {
    async prepareRun(request, authenticatedSession) {
      calls.push(["prepare", request, authenticatedSession]);
      return { runContext: context };
    },
    async execute(request, authenticatedSession) {
      calls.push(["execute", request, authenticatedSession]);
      if (options.executeError) throw options.executeError;
      runReceipt = signReceipt({
        schemaVersion: 5,
        receiptId: "run_receipt:test",
        runId,
        mode: "test",
        logicalSessionId: sessionContext.logicalSessionId,
        workItemId: sessionContext.workItemId,
        repositoryId: snapshot.receipt.repositoryId,
        worktreeId: snapshot.receipt.worktreeId,
        sourceFingerprint: snapshot.receipt.sourceFingerprint,
        startupBindingReceiptRef: runStartupBindingReceiptRef(snapshot.startupReceipt),
        repositorySourceSnapshotReceiptRef: snapshotReceiptRef(snapshot.receipt),
        toolsetValidationReceiptRef: null,
        state: options.runState ?? "completed",
        outcome: options.runOutcome ?? "passed",
        runContextHash: "4".repeat(64),
        dataRootBindingId: "data_root_binding:test",
        processLeaseRefs: [], portLeaseRefs: [],
        dataLeaseRef: { leaseId: "lease:data-test", kind: "data", fencingToken: 7, resourceVersion: 1 },
        credentialLeaseRefs: [],
        fencingToken: context.fencingToken,
        resourceVersion: 2,
        eventRefs: [], metricsRef: null,
        readyAt: now, startedAt: now, stoppedAt: now, completedAt: now,
        error: (options.runState ?? "completed") === "failed"
          ? { code: "SEMANTIC_EXECUTION_FAILED", message: "Semantic execution failed.", traceId: null, detailsHash: null }
          : null
      });
      return { receipt: runReceipt, results: options.results ?? [] };
    },
    async cleanup(request, authenticatedSession) {
      calls.push(["cleanup", request, authenticatedSession]);
      if (options.cleanupError) throw options.cleanupError;
      return { receipt: signReceipt({
        schemaVersion: 4,
        receiptId: "cleanup_receipt:test",
        cleanupOperationId: "cleanup:test",
        runId,
        runReceiptRef: {
          receiptId: runReceipt.receiptId,
          receiptHash: runReceipt.receiptHash,
          schemaVersion: 5,
          issuer: "run_isolation",
          resourceVersion: runReceipt.resourceVersion,
          artifactRef: {
            ...RUN_RECEIPT_ARTIFACT,
            receiptType: "RunReceipt"
          }
        },
        logicalSessionId: sessionContext.logicalSessionId,
        workItemId: sessionContext.workItemId,
        repositoryId: snapshot.receipt.repositoryId,
        worktreeId: snapshot.receipt.worktreeId,
        sourceFingerprint: snapshot.receipt.sourceFingerprint,
        outcome: options.cleanupOutcome ?? "cleaned",
        policy: "success_default",
        ownerSessionId: sessionContext.logicalSessionId,
        retentionReason: null,
        retentionPolicyVersion: "retention:v1",
        retainUntil: null,
        quotaBytes: 1048576,
        observedBytes: 0,
        fencingToken: context.fencingToken,
        resourceVersion: 3,
        dataRootBindingId: "data_root_binding:test",
        sourceIdentityHash: "5".repeat(64),
        trashIdentityHash: null,
        safetyChecks: Object.fromEntries([
          "canonicalRoot", "runMarker", "identity", "leaseOwner", "fence", "noSymlink", "noHardlinkEscape",
          "noMountCrossing", "noActiveProcess", "noActivePort", "noActiveDataLease", "noActiveCredentialLease",
          "serverHandleClosed", "targetBoundary"
        ].map((name, index) => [name, { status: "passed", errorCode: null, evidenceHash: index.toString(16).padStart(64, "0") }])),
        processReconciliation: "matchedExited",
        bytesReclaimed: 0,
        filesRemoved: 0,
        eventRefs: [],
        startedAt: now,
        finishedAt: now,
        error: null
      }) };
    }
  };
  const commandDescriptors = {
    async create(descriptor) {
      calls.push(["commandDescriptor", descriptor]);
      return "command_descriptor:semantic-test";
    }
  };
  return {
    calls,
    service,
    port: new ProjectCodeRunIsolationPort({
      service,
      commandDescriptors,
      capabilities: { localSemantic: true, networkAccess: false, languages: ["swift", "typescript"] }
    })
  };
}

export async function git(directory, args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return stdout.trim();
}
