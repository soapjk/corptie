import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    objectiveId: "objective:11111111-1111-1111-1111-111111111111", taskId: "task:test", logicalSessionId: "logical:test"
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
    schemaVersion: 3,
    resourceVersion: 1,
    artifactRef: {
      artifactId: "artifact:ed9a09d9-d2b1-4446-9a34-4ef491570ef3",
      version: 1,
      contentHash: "6d96157deeb6d675a572478247312650a8eba8bb58f54568fd3aa25af8013669",
      relation: "implementation_spec",
      receiptType: "ToolsetValidationReceipt",
      schemaVersion: 3
    },
    identity: {
      logicalSessionId: "logical:test",
      objectiveId: snapshot.receipt.objectiveId,
      taskId: "task:test",
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
    taskId: sessionContext.taskId,
    repositoryId: snapshot.receipt.repositoryId,
    worktreeId: snapshot.receipt.worktreeId,
    sourceFingerprint: snapshot.receipt.sourceFingerprint,
    resourceVersion: 1,
    fencingToken: 7,
    tmpDir: null,
    toolsetValidationReceiptPointer: null
  };
  let runReceipt;
  let commandOutput = null;
  const coordinator = {
    service: {
      store: {
        latestCleanupReceipt: () => null,
        latestCleanup: () => null
      },
      inspect(requestedRunId) {
        assert.equal(requestedRunId, runId);
        return context;
      },
      takeCommandOutput(requestedRunId) {
        assert.equal(requestedRunId, runId);
        const output = commandOutput;
        commandOutput = null;
        return output;
      }
    },
    async prepareRun(request, authenticatedSession, { toolsetReceiptResolver } = {}) {
      calls.push(["prepare", request, authenticatedSession]);
      context.tmpDir ??= await mkdtemp(join(tmpdir(), "corptie-project-code-run-"));
      context.toolsetValidationReceiptPointer = request.toolsetValidationReceiptPointer;
      assert.ok(await toolsetReceiptResolver?.(request.toolsetValidationReceiptPointer.receiptId));
      return { context };
    },
    async execute(request, authenticatedSession) {
      calls.push(["execute", request, authenticatedSession]);
      if (options.executeError) throw options.executeError;
      const runFields = {
        schemaVersion: 6,
        receiptId: "run_receipt:test",
        runId,
        mode: "test",
        logicalSessionId: sessionContext.logicalSessionId,
        taskId: sessionContext.taskId,
        repositoryId: snapshot.receipt.repositoryId,
        worktreeId: snapshot.receipt.worktreeId,
        sourceFingerprint: snapshot.receipt.sourceFingerprint,
        startupBindingReceiptRef: runStartupBindingReceiptRef(snapshot.startupReceipt),
        repositorySourceSnapshotReceiptRef: snapshotReceiptRef(snapshot.receipt),
        toolsetValidationReceiptPointer: context.toolsetValidationReceiptPointer,
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
      };
      Object.assign(runFields, options.runReceiptOverrides ?? {});
      runReceipt = signReceipt(runFields);
      commandOutput = JSON.stringify({
        schemaVersion: 1,
        sourceFingerprint: snapshot.receipt.sourceFingerprint,
        results: options.results ?? []
      });
      return runReceipt;
    },
    async cleanup(request, authenticatedSession) {
      calls.push(["cleanup", request, authenticatedSession]);
      if (options.cleanupError) throw options.cleanupError;
      const cleanupFields = {
        schemaVersion: 4,
        receiptId: "cleanup_receipt:test",
        cleanupOperationId: "cleanup:test",
        runId,
        runReceiptRef: {
          receiptId: runReceipt.receiptId,
          receiptHash: runReceipt.receiptHash,
          schemaVersion: 6,
          issuer: "run_isolation",
          resourceVersion: runReceipt.resourceVersion,
          artifactRef: {
            ...RUN_RECEIPT_ARTIFACT,
            receiptType: "RunReceipt"
          }
        },
        logicalSessionId: sessionContext.logicalSessionId,
        taskId: sessionContext.taskId,
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
        error: null,
        ...(options.cleanupReceiptOverrides ?? {})
      };
      if (options.validUnknownCleanup === true) {
        cleanupFields.outcome = "unknown";
        cleanupFields.processReconciliation = "indeterminate";
        cleanupFields.error = {
          code: "RUN_CLEANUP_RECONCILIATION_UNKNOWN",
          message: "Cleanup outcome requires reconciliation.",
          traceId: null,
          detailsHash: null
        };
        cleanupFields.safetyChecks = {
          ...cleanupFields.safetyChecks,
          canonicalRoot: {
            status: "indeterminate",
            errorCode: "RUN_CLEANUP_CANONICAL_ROOT_INVALID",
            evidenceHash: "f".repeat(64)
          }
        };
      }
      await rm(context.tmpDir, { recursive: true, force: true });
      return signReceipt(cleanupFields);
    },
    async cancel(request, authenticatedSession) {
      calls.push(["cancel", request, authenticatedSession]);
      return runReceipt;
    }
  };
  return {
    calls,
    coordinator,
    port: new ProjectCodeRunIsolationPort({
      coordinator,
      capabilities: { localSemantic: true, networkAccess: false, languages: ["swift", "typescript"] }
    })
  };
}

export async function git(directory, args) {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return stdout.trim();
}
