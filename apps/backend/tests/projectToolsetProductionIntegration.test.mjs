import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createProjectToolsetProductionComposition } from "../src/application/projectToolsetProductionComposition.mjs";
import { ProjectCodeSearchApplicationService } from "../src/project-code/projectCodeApplicationService.mjs";
import { ProjectCodeStartupReceiptRepository } from "../src/project-code/projectCodeStartupReceiptRepository.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { RunIsolationExecutionCoordinator } from "../src/runIsolation/index.mjs";
import { canonicalJson } from "../src/runtime/projectToolsetCanonical.mjs";
import { createProjectCodeFixture, startupReceiptFor } from "./helpers/projectCodeTestFixture.mjs";
import { fixture as createRunFixture } from "./runIsolationTestHelpers.mjs";

const externalRoot = "/Volumes/T9/.corptie/test-tmp";
const objectiveId = "objective:11111111-1111-4111-8111-111111111111";

test("production initialize/update composes authoritative Startup, Snapshot, Toolset and real Run v6/Cleanup v4", async (t) => {
  await mkdir(externalRoot, { recursive: true });
  const source = await createProjectCodeFixture({ parent: externalRoot, files: swiftPackageFiles() });
  t.after(() => rm(source.directory, { recursive: true, force: true }));
  const sessionContext = { objectiveId, taskId: "task:test", logicalSessionId: "logical:test" };
  const startupReceipt = startupReceiptFor({
    identity: source.identity, commitOid: source.commitOid, treeOid: source.treeOid,
    sessionContext, binding: source.binding
  });
  const store = productionStore({ source, sessionContext, startupReceipt });
  const startupReceipts = new ProjectCodeStartupReceiptRepository({ store });
  const projectCode = new ProjectCodeSearchApplicationService({
    store, startupReceipts, snapshotBuilder: new RepositorySourceSnapshotBuilder(),
    searchService: { async search() { throw new Error("search is outside this Toolset test"); } }
  });
  const { service: runService } = await createRunFixture(t);
  const coordinator = new RunIsolationExecutionCoordinator({ service: runService });
  const backgroundCalls = [];
  const composition = createProjectToolsetProductionComposition({
    store, startupReceipts, projectCodeApplicationService: projectCode,
    runIsolationCoordinator: coordinator,
    backgroundAgentService: { async run(input) { backgroundCalls.push(input); throw new Error("Swift detection must not invoke generation."); } },
    dataRoot: join(runService.dataRoot, "toolset-control"), environment: "test"
  });
  t.after(() => composition.toolsetStore.close());

  const authenticatedSession = { logicalSessionId: sessionContext.logicalSessionId, taskId: sessionContext.taskId };
  const initialized = await composition.service.initialize(source.directory, { authenticatedSession, idempotencyKey: "toolset-production:init" });
  assert.equal(initialized.state, "ready", JSON.stringify({ initialized, operation: await composition.toolsetStore.get(initialized.operationId) })); assert.equal(initialized.outcome, "passed");
  assert.deepEqual(initialized.receipt.actionReceipts.map((item) => item.kind), ["build", "test"]);
  assert.ok(initialized.receipt.actionReceipts.every((item) => item.runReceiptRef.schemaVersion === 6 && item.cleanupReceiptRef.schemaVersion === 4));
  assert.equal(backgroundCalls.length, 0);
  const runtime = await composition.runtimeAuthority(sessionContext.logicalSessionId);
  assert.equal(runtime.toolsetValidationReceiptPointer.receiptHash, initialized.receipt.receiptHash);
  assert.equal(runtime.snapshot.sourceFingerprint, initialized.receipt.snapshotRef.sourceFingerprint);
  const resolved = await composition.runAuthorityResolver.resolve({
    logicalSessionId: runtime.logicalSessionId, taskId: runtime.taskId,
    repositoryId: runtime.repositoryId, worktreeId: runtime.worktreeId,
    action: "build", bindingId: runtime.bindingId, bindingGeneration: runtime.bindingGeneration
  });
  assert.equal(resolved.toolsetValidationReceiptPointer.receiptId, initialized.receipt.receiptId);
  assert.equal(resolved.repositorySourceSnapshotReceiptRef.sourceFingerprint, initialized.receipt.snapshotRef.sourceFingerprint);

  const runSession = {
    logicalSessionId: runtime.logicalSessionId, taskId: runtime.taskId,
    repositoryId: runtime.repositoryId, worktreeId: runtime.worktreeId
  };
  const prepare = {
    mode: "test", sourceAware: true, toolsetRequired: true,
    startupBindingReceiptRef: runtime.startupBindingReceiptRef,
    repositorySourceSnapshotReceiptRef: runtime.repositorySourceSnapshotReceiptRef,
    toolsetValidationReceiptPointer: runtime.toolsetValidationReceiptPointer,
    idempotencyKey: "toolset-production:pointer-negative"
  };
  const receiptResolver = composition.resolveToolsetReceipt;
  await assert.rejects(() => coordinator.prepareRun({ ...prepare,
    toolsetValidationReceiptPointer: { ...prepare.toolsetValidationReceiptPointer, receiptHash: "f".repeat(64) }
  }, runSession, { toolsetReceiptResolver: receiptResolver }), (error) => error.code === "RUN_TOOLSET_RECEIPT_HASH_MISMATCH");
  await assert.rejects(() => coordinator.prepareRun({ ...prepare, idempotencyKey: "toolset-production:fingerprint-negative",
    toolsetValidationReceiptPointer: { ...prepare.toolsetValidationReceiptPointer, sourceFingerprint: "f".repeat(64) }
  }, runSession, { toolsetReceiptResolver: receiptResolver }), (error) => error.code === "RUN_SOURCE_FINGERPRINT_MISMATCH");
  await assert.rejects(() => coordinator.prepareRun({ ...prepare, idempotencyKey: "toolset-production:unknown-negative",
    toolsetValidationReceiptPointer: { ...prepare.toolsetValidationReceiptPointer, receiptId: "toolset_validation_receipt:missing" }
  }, runSession, { toolsetReceiptResolver: receiptResolver }), (error) => error.code === "RUN_TOOLSET_RECEIPT_UNRESOLVED");

  await assert.rejects(() => composition.runAuthorityResolver.resolve({
    logicalSessionId: runtime.logicalSessionId, taskId: runtime.taskId,
    repositoryId: runtime.repositoryId, worktreeId: runtime.worktreeId,
    action: "build", bindingId: runtime.bindingId, bindingGeneration: runtime.bindingGeneration + 1
  }), (error) => error.code === "STARTUP_BINDING_STALE");
});

test("production authority fails closed for stale source and active receipt hash mismatch", async (t) => {
  await mkdir(externalRoot, { recursive: true });
  const source = await createProjectCodeFixture({ parent: externalRoot, files: swiftPackageFiles() });
  t.after(() => rm(source.directory, { recursive: true, force: true }));
  const sessionContext = { objectiveId, taskId: "task:test", logicalSessionId: "logical:test" };
  const startupReceipt = startupReceiptFor({ identity: source.identity, commitOid: source.commitOid, treeOid: source.treeOid, sessionContext, binding: source.binding });
  const store = productionStore({ source, sessionContext, startupReceipt });
  const startupReceipts = new ProjectCodeStartupReceiptRepository({ store });
  const projectCode = new ProjectCodeSearchApplicationService({ store, startupReceipts, snapshotBuilder: new RepositorySourceSnapshotBuilder(), searchService: {} });
  const { service: runService } = await createRunFixture(t);
  const composition = createProjectToolsetProductionComposition({
    store, startupReceipts, projectCodeApplicationService: projectCode,
    runIsolationCoordinator: new RunIsolationExecutionCoordinator({ service: runService }),
    backgroundAgentService: { async run() { throw new Error("unexpected background generation"); } },
    dataRoot: join(runService.dataRoot, "toolset-control-negative"), environment: "test"
  });
  t.after(() => composition.toolsetStore.close());
  const authenticatedSession = { logicalSessionId: sessionContext.logicalSessionId, taskId: sessionContext.taskId };
  const initialized = await composition.service.initialize(source.directory, { authenticatedSession, idempotencyKey: "toolset-production:negative" });
  assert.equal(initialized.state, "ready", JSON.stringify({ initialized, operation: await composition.toolsetStore.get(initialized.operationId) }));

  const activePath = join(source.directory, ".corptie/project-toolset/active.json");
  const active = JSON.parse(await readFile(activePath, "utf8"));
  await writeFile(activePath, `${canonicalJson({ ...active, receiptHash: "f".repeat(64) })}\n`);
  await assert.rejects(() => composition.runtimeAuthority(sessionContext.logicalSessionId), (error) => error.code === "RECEIPT_INVALID");
  await writeFile(activePath, `${canonicalJson(active)}\n`);

  await writeFile(join(source.directory, "Sources/App/App.swift"), "public struct App { public init() {} }\n// changed\n");
  await assert.rejects(() => composition.runtimeAuthority(sessionContext.logicalSessionId),
    (error) => ["SOURCE_FINGERPRINT_MISMATCH", "SNAPSHOT_STALE"].includes(error.code));
});

function productionStore({ source, sessionContext, startupReceipt }) {
  const receipts = new Map();
  const logical = {
    logicalSessionId: sessionContext.logicalSessionId,
    activeBinding: {
      bindingId: startupReceipt.providerBindingId,
      logicalSessionId: sessionContext.logicalSessionId,
      worktreeId: startupReceipt.worktreeId,
      boundCwd: startupReceipt.canonicalWorktreePath,
      routingVersion: startupReceipt.bindingGeneration,
      state: "active"
    }
  };
  return {
    selectOne(sql, parameters) {
      if (/work_session_startup_receipts/.test(sql)) {
        if (parameters.length === 1 && parameters[0] === sessionContext.logicalSessionId) return { receipt_json: canonicalJson(startupReceipt) };
        if (parameters[0] === startupReceipt.startupOperationId && parameters[1] === startupReceipt.receiptHash) return { receipt_json: canonicalJson(startupReceipt) };
      }
      return null;
    },
    assertLogicalWorkSessionBinding(logicalSessionId) {
      assert.equal(logicalSessionId, sessionContext.logicalSessionId);
      return { ...sessionContext, sessionId: "session:test", agentId: "agent:test" };
    },
    getLogicalSession: () => logical,
    getSession: () => ({ id: "session:test", sessionKind: "worker", taskId: sessionContext.taskId, objectiveId: sessionContext.objectiveId }),
    getTask: () => ({ id: sessionContext.taskId, objective_id: sessionContext.objectiveId }),
    putProjectCodeReceipt(record) { receipts.set(record.receiptId, structuredClone(record)); return record; },
    getProjectCodeReceiptById(receiptId) {
      const value = receipts.get(receiptId); return value ? { ...structuredClone(value), logicalSessionId: value.logicalSessionId } : null;
    },
    getProjectCodeReceipt(receiptId, logicalSessionId) {
      const value = receipts.get(receiptId); return value?.logicalSessionId === logicalSessionId ? { receiptType: value.receiptType, receipt: structuredClone(value.receipt) } : null;
    },
    source
  };
}

function swiftPackageFiles() {
  return {
    "Package.swift": "// swift-tools-version: 5.9\nimport PackageDescription\nlet package = Package(name: \"App\", products: [.library(name: \"App\", targets: [\"App\"])], targets: [.target(name: \"App\"), .testTarget(name: \"AppTests\", dependencies: [\"App\"])])\n",
    "Sources/App/App.swift": "public struct App { public init() {} }\n",
    "Tests/AppTests/AppTests.swift": "import XCTest\n@testable import App\nfinal class AppTests: XCTestCase { func testApp() { _ = App() } }\n",
    ".gitignore": ".build/\n"
  };
}
