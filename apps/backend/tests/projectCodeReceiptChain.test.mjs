import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { createProjectCodeFixture, toolsetReceiptFor } from "./helpers/projectCodeTestFixture.mjs";

test("Startup → Snapshot → Toolset → Search is zero-copy and contains no backwards receipt edge", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const toolset = toolsetReceiptFor(snapshot);
    const result = await new ProjectCodeSearchService({ snapshotBuilder: builder }).search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "receipt-chain", query: "exactNeedle", mode: "exact",
      toolsetValidationReceipt: toolset, toolsetRequired: true
    });
    assert.equal(result.receipt.startupBindingRef.startupReceiptHash, fixture.startupReceipt.receiptHash);
    assert.equal(result.receipt.snapshotReceiptRef.receiptId, snapshot.receipt.receiptId);
    assert.equal(result.receipt.snapshotReceiptRef.sourceFingerprint, snapshot.receipt.sourceFingerprint);
    assert.equal(result.receipt.toolsetValidationReceiptRef.receiptId, toolset.receiptId);
    assert.equal(Object.hasOwn(snapshot.receipt, "toolsetValidationReceiptRef"), false);
    assert.equal(Object.hasOwn(snapshot.receipt, "queryHash"), false);
    assert.equal(Object.hasOwn(result.receipt, "startupReceipt"), false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("mismatched Toolset Snapshot echo fails before search execution", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const toolset = toolsetReceiptFor(snapshot, {
      receiptId: "toolset_validation_receipt:mismatch",
      snapshotRef: {
        receiptId: "snapshot:other",
        receiptHash: snapshot.receipt.receiptHash,
        sourceFingerprint: "d".repeat(64),
        schemaVersion: 1,
        resourceVersion: 1,
        artifactRef: snapshot.receipt.artifactRef
      }
    });
    const result = await new ProjectCodeSearchService({ snapshotBuilder: builder }).search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "receipt-chain-mismatch", query: "exactNeedle", mode: "exact",
      toolsetValidationReceipt: toolset, toolsetRequired: true
    });
    assert.equal(result.results.length, 0);
    assert.equal(result.receipt.outcome, "failed");
    assert.equal(result.receipt.errorCode, "TOOLSET_SNAPSHOT_MISMATCH");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
