import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { loadRunIsolationReceiptSchema, sha256Hex } from "../src/project-code/projectCodeContracts.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { createProjectCodeFixture, formalRunIsolationPort } from "./helpers/projectCodeTestFixture.mjs";

test("approved RunReceipt v5 and CleanupReceipt v4 schema sections are fixed, parsed and closed", async () => {
  const fixtures = [
    ["run-receipt-v5.schema.json", "RunReceipt", "1f3f91c1f73352d90a98289e2d73112175f470f518fca5f6066ab8c4768012df", 5],
    ["cleanup-receipt-v4.schema.json", "CleanupReceipt", "fac1c7b7f1906dcd80bc0bc8d01eef0da60a30fcaa2860b83a6c0f5d731b8adf", 4]
  ];
  for (const [name, type, hash, version] of fixtures) {
    const bytes = await readFile(new URL(`../src/contracts/${name}`, import.meta.url));
    assert.equal(sha256Hex(bytes), hash);
    const schema = await loadRunIsolationReceiptSchema(type);
    assert.equal(schema.properties.schemaVersion.const, version);
    const objects = [];
    visit(schema, (node) => { if (node?.type === "object") objects.push(node); });
    assert.ok(objects.length > 0);
    assert.ok(objects.every((node) => node.additionalProperties === false));
  }
});

test("Search delegates isolation lifecycle and never reports success after cleanup failure", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Only.swift": "struct Only {}\n" } });
  const calls = [];
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const cleanupError = new Error("cleanup failed");
    cleanupError.code = "RUN_CLEANUP_FAILED";
    const isolation = formalRunIsolationPort(snapshot, fixture.sessionContext, { calls, cleanupError });
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, runIsolationPort: isolation.port });
    const result = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "cleanup-failure", query: "concept", mode: "semantic" });
    assert.deepEqual(calls.map(([name]) => name).filter((name) => name !== "commandDescriptor"), ["prepare", "execute", "cleanup"]);
    assert.equal(result.receipt.outcome, "failed");
    assert.equal(result.receipt.errorCode, "RUN_CLEANUP_FAILED");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("non-isolated L0 leaves Run/Cleanup refs and runId all null", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const result = await new ProjectCodeSearchService({ snapshotBuilder: builder }).search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "no-isolation", query: "exactNeedle", mode: "exact"
    });
    assert.deepEqual([result.receipt.runIsolationReceiptRef, result.receipt.runId, result.receipt.cleanupReceiptRef], [null, null, null]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("L3 cancellation is closed by Cleanup v4 and preserved as a cancelled Search receipt", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Only.swift": "struct Only {}\n" } });
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const isolation = formalRunIsolationPort(snapshot, fixture.sessionContext, {
      runState: "cancelled",
      runOutcome: "cancelled"
    });
    const result = await new ProjectCodeSearchService({ snapshotBuilder: builder, runIsolationPort: isolation.port }).search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "l3-cancel", query: "concept", mode: "semantic"
    });
    assert.equal(result.receipt.outcome, "cancelled");
    assert.equal(result.receipt.errorCode, "QUERY_CANCELLED");
    assert.equal(result.receipt.runIsolationReceiptRef.schemaVersion, 5);
    assert.equal(result.receipt.cleanupReceiptRef.schemaVersion, 4);
    assert.deepEqual(isolation.calls.map(([name]) => name), ["prepare", "commandDescriptor", "execute", "cleanup"]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("L3 failed RunReceipt v5 still cleans and cannot produce successful Search", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Only.swift": "struct Only {}\n" } });
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const isolation = formalRunIsolationPort(snapshot, fixture.sessionContext, {
      runState: "failed",
      runOutcome: "failed"
    });
    const result = await new ProjectCodeSearchService({ snapshotBuilder: builder, runIsolationPort: isolation.port }).search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "l3-fail", query: "concept", mode: "semantic"
    });
    assert.equal(result.receipt.outcome, "failed");
    assert.equal(result.receipt.errorCode, "RUN_EXECUTION_FAILED");
    assert.ok(result.receipt.cleanupReceiptRef);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, callback);
}
