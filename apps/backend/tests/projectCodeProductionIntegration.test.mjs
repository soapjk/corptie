import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { ProjectCodeSearchApplicationService } from "../src/project-code/projectCodeApplicationService.mjs";
import { projectCodeDynamicTools, callProjectCodeDynamicTool } from "../src/project-code/projectCodeDynamicTools.mjs";
import { ProjectCodeIndexStore } from "../src/project-code/projectCodeIndexStore.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { createProjectCodeFixture, formalRunIsolationPort } from "./helpers/projectCodeTestFixture.mjs";

test("Project Tool Host production entry persists authoritative L0-L3 Snapshot/Search receipts", async () => {
  const fixture = await createProjectCodeFixture({
    files: { "Sources/App.swift": "struct ProductionNeedleCoordinator {}\n" }
  });
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-project-code-data-"));
  const receipts = new Map();
  const store = storeFor(fixture, receipts);
  const builder = new RepositorySourceSnapshotBuilder();
  const indexStore = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
  let application = applicationFor({ store, fixture, builder, indexStore });
  const catalog = new HostToolCatalog([{
    id: "project-code",
    tools: projectCodeDynamicTools,
    authorize: ({ metadata }) => metadata?.sessionKind === "worker" && Boolean(metadata?.logicalSessionId),
    execute: (input) => callProjectCodeDynamicTool(application, input)
  }]);
  const metadata = {
    logicalSessionId: fixture.sessionContext.logicalSessionId,
    sessionKind: "worker",
    objectiveId: fixture.sessionContext.objectiveId,
    workItemId: fixture.sessionContext.workItemId
  };
  try {
    const snap = await catalog.execute({ tool: "corptie_project_code_snapshot", metadata });
    assert.equal(receipts.get(snap.receipt.receiptId).receiptType, "RepositorySourceSnapshotReceipt");

    const l0 = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: { snapshot_receipt_id: snap.receipt.receiptId, query: "ProductionNeedle", mode: "exact" }
    });
    assert.equal(l0.searchReceipt.layers[0].layer, "L0");
    assert.equal(indexStore.stats.opens, 0);
    assert.equal(receipts.get(l0.searchReceipt.receiptId).receiptType, "SearchReceipt");

    const l2 = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: { snapshot_receipt_id: snap.receipt.receiptId, query: "Coordinator", mode: "symbols" }
    });
    assert.ok(l2.searchReceipt.layers.some((layer) => layer.layer === "L2"));
    assert.equal(indexStore.stats.l2Builds, 1);

    const capturedSnapshot = {
      receipt: snap.receipt,
      startupReceipt: fixture.startupReceipt
    };
    const isolation = formalRunIsolationPort(capturedSnapshot, fixture.sessionContext, {
      results: [{ path: "Sources/App.swift", line: 1, kind: "semantic", score: 0.95, snippet: "not persisted" }]
    });
    application = applicationFor({ store, fixture, builder, indexStore, runIsolationPort: isolation.port });
    const l3 = await catalog.execute({
      tool: "corptie_project_code_search", metadata,
      arguments: { snapshot_receipt_id: snap.receipt.receiptId, query: "coordination concept", mode: "semantic" }
    });
    assert.deepEqual(isolation.calls.map(([name]) => name), ["prepare", "commandDescriptor", "execute", "cleanup"]);
    assert.equal(l3.searchReceipt.runIsolationReceiptRef.schemaVersion, 5);
    assert.equal(l3.searchReceipt.cleanupReceiptRef.schemaVersion, 4);
    assert.equal(JSON.stringify(receipts.get(l3.searchReceipt.receiptId).receipt).includes("not persisted"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function applicationFor({ store, fixture, builder, indexStore, runIsolationPort = null }) {
  return new ProjectCodeSearchApplicationService({
    store,
    startupReceipts: { require: () => fixture.startupReceipt },
    snapshotBuilder: builder,
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
    getWorkItem: () => ({ id: fixture.sessionContext.workItemId }),
    putProjectCodeReceipt(record) { receipts.set(record.receiptId, structuredClone(record)); },
    getProjectCodeReceipt(receiptId, logicalSessionId) {
      const record = receipts.get(receiptId);
      return record?.logicalSessionId === logicalSessionId ? structuredClone(record) : null;
    }
  };
}
