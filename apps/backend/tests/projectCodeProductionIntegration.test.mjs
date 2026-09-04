import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { ProjectCodeSearchApplicationService } from "../src/project-code/projectCodeApplicationService.mjs";
import {
  createProjectCodeHostNamespace,
  PROJECT_CODE_MODEL_RECOMMENDATION_ENABLED,
  projectCodeDynamicTools
} from "../src/project-code/projectCodeDynamicTools.mjs";
import { ProjectCodeIndexStore } from "../src/project-code/projectCodeIndexStore.mjs";
import { ProjectCodeRunIsolationPort } from "../src/project-code/projectCodeRunIsolationPort.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { ProjectCodeSourceRevisionMonitor } from "../src/project-code/projectCodeSourceRevisionMonitor.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { RunIsolationExecutionCoordinator } from "../src/runIsolation/runIsolationExecutionCoordinator.mjs";
import { createProjectCodeFixture, toolsetReceiptFor } from "./helpers/projectCodeTestFixture.mjs";
import { fixture as createRunIsolationFixture } from "./runIsolationTestHelpers.mjs";

test("Project Tool Host production entry persists authoritative L0-L3 receipts through real Run v6 isolation", async (t) => {
  const fixture = await createProjectCodeFixture({
    files: { "Sources/App.swift": "struct ProductionNeedleCoordinator {}\n" }
  });
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-project-code-data-"));
  const receipts = new Map();
  const store = storeFor(fixture, receipts);
  const builder = new RepositorySourceSnapshotBuilder();
  const indexStore = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
  let application = applicationFor({ store, fixture, builder, indexStore });
  const catalog = new HostToolCatalog([createProjectCodeHostNamespace({
    getService: () => application,
    validateRoute: ({ metadata: routed }) => {
      if (routed?.logicalSessionId !== fixture.sessionContext.logicalSessionId) {
        const error = new Error("stale project-code route");
        error.code = "PROJECT_CODE_SESSION_ROUTE_STALE";
        throw error;
      }
    }
  })]);
  const metadata = {
    logicalSessionId: fixture.sessionContext.logicalSessionId,
    sessionKind: "worker",
    workId: fixture.sessionContext.workId,
    taskId: fixture.sessionContext.taskId
  };
  try {
    const snap = await catalog.execute({ tool: "corptie_project_code_snapshot", metadata });
    assert.equal(receipts.get(snap.receipt.receiptId).receiptType, "RepositorySourceSnapshotReceipt");
    await assert.rejects(
      () => catalog.execute({
        tool: "corptie_project_code_snapshot",
        metadata: { ...metadata, logicalSessionId: "logical:stale" }
      }),
      (error) => error.code === "PROJECT_CODE_SESSION_ROUTE_STALE"
    );

    const l0 = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: { snapshot_receipt_id: snap.receipt.receiptId, response_detail: "full", query: "ProductionNeedle", mode: "exact" }
    });
    assert.equal(l0.searchReceipt.layers[0].layer, "L0");
    assert.equal(indexStore.stats.opens, 0);
    assert.equal(receipts.get(l0.searchReceipt.receiptId).receiptType, "SearchReceipt");
    assert.equal(
      store.getProjectCodeReceipt(l0.searchReceipt.receiptId, metadata.logicalSessionId).receipt.receiptHash,
      l0.searchReceipt.receiptHash
    );
    const createdInline = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: { snapshot_policy: "create_new", query: "ProductionNeedle", mode: "exact" }
    });
    assert.equal(createdInline.snapshot.reused, false);
    const compact = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: { query: "ProductionNeedle", mode: "exact" }
    });
    assert.equal(Object.hasOwn(compact, "searchReceipt"), false);
    assert.equal(compact.snapshot.reused, true);
    assert.equal(compact.search.outcome, "success");
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 16 * 1024);
    const fullReceipt = await catalog.execute({
      tool: "corptie_project_code_receipt_get", metadata,
      arguments: { receipt_id: compact.search.receiptId }
    });
    assert.equal(fullReceipt.receiptType, "SearchReceipt");
    assert.equal(fullReceipt.receipt.receiptId, compact.search.receiptId);
    await assert.rejects(() => application.search({ logicalSessionId: metadata.logicalSessionId,
      snapshotPolicy: "require_exact", query: "ProductionNeedle" }),
    (error) => error.code === "QUERY_INVALID");

    const [firstPrewarm, duplicatePrewarm] = await Promise.all([
      application.prewarm({ logicalSessionId: metadata.logicalSessionId }),
      application.prewarm({ logicalSessionId: metadata.logicalSessionId })
    ]);
    assert.equal(firstPrewarm.status, "ready");
    assert.equal(duplicatePrewarm.snapshotReceiptId, firstPrewarm.snapshotReceiptId);
    assert.equal(indexStore.stats.l2Builds, 1, "concurrent Session-ready prewarm must single-flight");
    assert.equal(application.prewarmSummary().ready, 1);
    assert.equal(application.prewarmSummary().failed, 0);

    const l2 = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: { snapshot_receipt_id: snap.receipt.receiptId, response_detail: "full", query: "Coordinator", mode: "symbols" }
    });
    assert.ok(l2.searchReceipt.layers.some((layer) => layer.layer === "L2"));
    assert.equal(indexStore.stats.l2Builds, 1);

    const capturedSnapshot = {
      receipt: snap.receipt,
      startupReceipt: fixture.startupReceipt
    };
    const { service: runIsolationService } = await createRunIsolationFixture(t);
    const runIsolationPort = new ProjectCodeRunIsolationPort({
      coordinator: new RunIsolationExecutionCoordinator({ service: runIsolationService }),
      capabilities: { localSemantic: true, networkAccess: false, languages: ["swift"] }
    });
    const toolsetReceipt = toolsetReceiptFor(capturedSnapshot);
    application = applicationFor({ store, fixture, builder, indexStore, runIsolationPort, toolsetReceipt });
    const l3 = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: {
        snapshot_receipt_id: snap.receipt.receiptId,
        response_detail: "full",
        toolset_validation_receipt_id: toolsetReceipt.receiptId,
        query: "coordination concept",
        mode: "semantic"
      }
    });
    assert.equal(l3.searchReceipt.outcome, "success", l3.searchReceipt.errorCode);
    assert.equal(l3.searchReceipt.runIsolationReceiptRef.schemaVersion, 6);
    assert.equal(l3.searchReceipt.cleanupReceiptRef.schemaVersion, 4);
    assert.equal(runIsolationService.store.latestCleanupReceipt(l3.searchReceipt.runId).outcome, "cleaned");
    assert.equal(JSON.stringify(receipts.get(l3.searchReceipt.receiptId).receipt).includes("ProductionNeedleCoordinator"), false);

    const cancellationSnapshot = await builder.build(fixture);
    const cancellationToolset = toolsetReceiptFor(cancellationSnapshot, { receiptId: "toolset_validation_receipt:cancel" });
    const cancelledPrepared = await runIsolationPort.prepareRun({
      snapshot: cancellationSnapshot,
      sessionContext: fixture.sessionContext,
      toolsetValidationReceipt: cancellationToolset,
      idempotencyKey: "production-project-code-cancel:prepare"
    });
    const controller = new AbortController();
    controller.abort("cancelled");
    const cancelled = await runIsolationPort.execute({
      prepared: cancelledPrepared,
      snapshot: cancellationSnapshot,
      sessionContext: fixture.sessionContext,
      query: "coordination concept",
      limit: 10,
      signal: controller.signal,
      idempotencyKey: "production-project-code-cancel:execute"
    });
    const cancelledCleanup = await runIsolationPort.cleanup({
      prepared: cancelledPrepared,
      snapshot: cancellationSnapshot,
      sessionContext: fixture.sessionContext,
      policy: "success_default",
      idempotencyKey: "production-project-code-cancel:cleanup"
    });
    assert.equal(cancelled.receipt.state, "cancelled");
    assert.equal(cancelledCleanup.receipt.schemaVersion, 4);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("project-code recommendation is enabled after three real-repository p50/p95 wins over rg", () => {
  assert.equal(PROJECT_CODE_MODEL_RECOMMENDATION_ENABLED, true);
  const search = projectCodeDynamicTools.find((definition) => definition.name === "corptie_project_code_search");
  assert.match(search.description, /prefer this indexed tool/i);
  assert.match(search.description, /fall back to provider-native search while the index is warming or degraded/i);
});

test("a changed Worktree invalidates the cached Snapshot and reuse_current refreshes once", async () => {
  const fixture = await createProjectCodeFixture();
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-project-code-refresh-"));
  const receipts = new Map();
  const builder = new RepositorySourceSnapshotBuilder();
  const monitor = new ProjectCodeSourceRevisionMonitor();
  try {
    const indexStore = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
    const application = applicationFor({ store: storeFor(fixture, receipts), fixture, builder,
      indexStore, freshnessMonitor: monitor });
    await application.prewarm({ logicalSessionId: fixture.sessionContext.logicalSessionId });
    const before = await application.search({ logicalSessionId: fixture.sessionContext.logicalSessionId,
      query: "exactNeedle", mode: "symbols", responseDetail: "full" });
    await writeFile(join(fixture.directory, "Sources/App.swift"), "struct SearchFixture {\n  func refreshedNeedle() {}\n}\n");
    const after = await application.search({ logicalSessionId: fixture.sessionContext.logicalSessionId,
      query: "refreshedNeedle", mode: "symbols", responseDetail: "full" });
    assert.notEqual(after.snapshotReceipt.receiptId, before.snapshotReceipt.receiptId);
    assert.ok(after.results.some((entry) => entry.symbol === "refreshedNeedle"));
    assert.ok(monitor.summary().invalidations >= 1);
    assert.equal(indexStore.stats.l2Builds, 2, "the changed source publishes one new incremental generation");
  } finally {
    monitor.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function applicationFor({ store, fixture, builder, indexStore, runIsolationPort = null, toolsetReceipt = null, freshnessMonitor = null }) {
  return new ProjectCodeSearchApplicationService({
    store,
    startupReceipts: { require: () => fixture.startupReceipt },
    toolsetReceipts: { require: ({ receiptId }) => receiptId === toolsetReceipt?.receiptId ? toolsetReceipt : null },
    snapshotBuilder: builder,
    freshnessMonitor,
    searchService: new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore, runIsolationPort })
  });
}

function storeFor(fixture, receipts) {
  const logical = {
    logicalSessionId: fixture.sessionContext.logicalSessionId,
    activeBinding: {
      bindingId: fixture.binding.providerBindingId,
      worktreeId: fixture.binding.worktreeId,
      boundCwd: fixture.binding.canonicalWorktreePath
    }
  };
  return {
    assertLogicalWorkSessionBinding: () => ({ ...fixture.sessionContext, sessionId: "session:test" }),
    getLogicalSession: () => logical,
    getSession: () => ({ id: "session:test", sessionKind: "worker" }),
    getTask: () => ({ id: fixture.sessionContext.taskId }),
    putProjectCodeReceipt(record) { receipts.set(record.receiptId, structuredClone(record)); },
    getProjectCodeReceipt(receiptId, logicalSessionId) {
      const record = receipts.get(receiptId);
      return record?.logicalSessionId === logicalSessionId ? structuredClone(record) : null;
    },
    getLatestProjectCodeSnapshot(logicalSessionId) {
      const records = [...receipts.values()].filter((record) => record.logicalSessionId === logicalSessionId
        && record.receiptType === "RepositorySourceSnapshotReceipt");
      return records.length > 0 ? structuredClone(records.at(-1)) : null;
    }
  };
}
