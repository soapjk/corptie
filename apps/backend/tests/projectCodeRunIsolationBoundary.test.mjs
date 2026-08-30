import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import {
  loadRunIsolationReceiptSchema,
  sha256Hex,
  signReceipt,
  snapshotReceiptRef,
  validateProjectCodeReceipt
} from "../src/project-code/projectCodeContracts.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import {
  createProjectCodeFixture,
  formalRunIsolationPort,
  toolsetReceiptFor
} from "./helpers/projectCodeTestFixture.mjs";

test("approved RunReceipt v6 and CleanupReceipt v4 schema sections are fixed, parsed and closed", async () => {
  const fixtures = [
    ["run-receipt-v6.schema.json", "RunReceipt", "eabcf91d8849a82bd5df3cb187213068521b5873446f636eb58af377f78e4c50", 6],
    ["cleanup-receipt-v4.schema.json", "CleanupReceipt", "e432d1d53611f13c6c985c2126c082aacc917fc7458106d216b65b71112b819d", 4]
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
    assert.equal(result.receipt.runIsolationReceiptRef.schemaVersion, 6);
    assert.equal(result.receipt.cleanupReceiptRef.schemaVersion, 4);
    assert.deepEqual(isolation.calls.map(([name]) => name), ["prepare", "commandDescriptor", "execute", "cleanup"]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("L3 failed RunReceipt v6 still cleans and cannot produce successful Search", async () => {
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

test("L3 validates the full Toolset v3 receipt then passes only the Run-owned six-field pointer", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Only.swift": "struct Only {}\n" } });
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const toolset = toolsetReceiptFor(snapshot);
    const isolation = formalRunIsolationPort(snapshot, fixture.sessionContext);
    const result = await new ProjectCodeSearchService({ snapshotBuilder: builder, runIsolationPort: isolation.port }).search({
      snapshot,
      sessionContext: fixture.sessionContext,
      searchScenarioId: "l3-toolset-v3",
      query: "concept",
      mode: "semantic",
      toolsetValidationReceipt: toolset,
      toolsetRequired: true
    });
    assert.equal(result.receipt.outcome, "success");
    const executeRequest = isolation.calls.find(([name]) => name === "execute")[1];
    assert.deepEqual(Object.keys(executeRequest.toolsetValidationReceiptPointer).sort(), [
      "receiptHash", "receiptId", "resourceVersion", "sourceFingerprint", "toolsetVersion", "validationPlanIdentity"
    ]);
    assert.equal(Object.hasOwn(executeRequest.toolsetValidationReceiptPointer, "artifactRef"), false);
    assert.equal(Object.hasOwn(executeRequest.toolsetValidationReceiptPointer, "schemaVersion"), false);

    const legacy = signReceipt({
      ...result.receipt,
      runIsolationReceiptRef: {
        ...result.receipt.runIsolationReceiptRef,
        schemaVersion: 5,
        artifactRef: {
          artifactId: "artifact:42cd149b-e230-4347-b4ff-b816c18cf25f",
          version: 1,
          contentHash: "b64fab56fdce275b29a99dd63f1ecd84a95419d3e0c8a4e752ebdf91e5321951",
          relation: "implementation_spec",
          receiptType: "RunReceipt",
          schemaVersion: 5
        }
      }
    });
    await assert.rejects(
      () => validateProjectCodeReceipt(legacy, "SearchReceipt"),
      (error) => error.code === "RECEIPT_REFERENCE_MISMATCH"
    );
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Run v6 identity, Snapshot, closed shape and legacy v5 mismatches fail closed", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Only.swift": "struct Only {}\n" } });
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const cases = [
      ["run-id", { runId: "run:other" }, "RUN_RECEIPT_REFERENCE_MISMATCH"],
      ["source", { sourceFingerprint: "d".repeat(64) }, "RUN_SOURCE_FINGERPRINT_MISMATCH"],
      ["snapshot", { repositorySourceSnapshotReceiptRef: { ...snapshotReceiptRef(snapshot.receipt), receiptId: "snapshot:other" } }, "SOURCE_SNAPSHOT_IDENTITY_MISMATCH"],
      ["unknown", { unexpectedField: true }, "RUN_CONTEXT_SCHEMA_UNSUPPORTED"],
      ["legacy-v5", { schemaVersion: 5 }, "RUN_CONTEXT_SCHEMA_UNSUPPORTED"]
    ];
    for (const [name, runReceiptOverrides, expectedCode] of cases) {
      const isolation = formalRunIsolationPort(snapshot, fixture.sessionContext, { runReceiptOverrides });
      const result = await new ProjectCodeSearchService({ snapshotBuilder: builder, runIsolationPort: isolation.port }).search({
        snapshot,
        sessionContext: fixture.sessionContext,
        searchScenarioId: `l3-mismatch-${name}`,
        query: "concept",
        mode: "semantic"
      });
      assert.equal(result.receipt.outcome, "failed", name);
      assert.equal(result.receipt.errorCode, expectedCode, name);
    }
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("valid Cleanup v4 unknown outcome is preserved as failed and never inferred cleaned", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Only.swift": "struct Only {}\n" } });
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const isolation = formalRunIsolationPort(snapshot, fixture.sessionContext, { validUnknownCleanup: true });
    const result = await new ProjectCodeSearchService({ snapshotBuilder: builder, runIsolationPort: isolation.port }).search({
      snapshot,
      sessionContext: fixture.sessionContext,
      searchScenarioId: "l3-cleanup-unknown",
      query: "concept",
      mode: "semantic"
    });
    assert.equal(result.receipt.outcome, "failed");
    assert.equal(result.receipt.errorCode, "RUN_CLEANUP_OUTCOME_UNKNOWN");
    assert.equal(result.receipt.cleanupReceiptRef, null);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, callback);
}
