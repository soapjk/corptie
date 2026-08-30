import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProjectCodeIndexStore } from "../src/project-code/projectCodeIndexStore.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { validateProjectCodeReceipt } from "../src/project-code/projectCodeContracts.mjs";
import { createProjectCodeFixture, formalRunIsolationPort, toolsetReceiptFor } from "./helpers/projectCodeTestFixture.mjs";

test("L0 exact rg has zero index startup cost and SearchReceipt contains only hashed evidence", async () => {
  const fixture = await createProjectCodeFixture();
  const telemetry = [];
  let indexAccesses = 0;
  const indexStore = {
    ensureLayer() { indexAccesses += 1; throw new Error("L0 must not touch indexes"); }
  };
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore, telemetrySink: (event) => telemetry.push(event) });
    const result = await service.search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "l0-exact", query: "exactNeedle", mode: "exact"
    });
    assert.equal(indexAccesses, 0);
    assert.equal(result.results[0].path, "Sources/App.swift");
    assert.equal(result.receipt.layers[0].layer, "L0");
    assert.equal(result.receipt.layers[0].indexHit, false);
    assert.equal(result.receipt.snapshotReceiptRef.receiptId, snapshot.receipt.receiptId);
    assert.equal(result.receipt.sourceFingerprint, snapshot.receipt.sourceFingerprint);
    assert.equal(Object.hasOwn(result.receipt, "snapshotReceiptId"), false);
    assert.equal(JSON.stringify(result.receipt).includes("exactNeedle"), false);
    assert.equal(JSON.stringify(telemetry).includes("exactNeedle"), false);
    assert.equal(JSON.stringify(telemetry).includes("Sources/App.swift"), false);
    await assert.doesNotReject(() => validateProjectCodeReceipt(result.receipt, "SearchReceipt"));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("L1 and L2 use immutable external-dataRoot generations and single-flight builds", async () => {
  const fixture = await createProjectCodeFixture();
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-index-root-"));
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const store = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
    const [first, second] = await Promise.all([
      store.ensureLayer(snapshot, "L2"), store.ensureLayer(snapshot, "L2")
    ]);
    assert.equal(store.stats.l1Builds, 1);
    assert.equal(store.stats.l2Builds, 1);
    assert.equal(first.index.generationHash, second.index.generationHash);
    assert.match(store.snapshotDirectory(snapshot), new RegExp(`${snapshot.receipt.sourceFingerprint}$`));

    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore: store });
    const search = await service.search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "l2-symbol", query: "layeredSymbol", mode: "symbols"
    });
    assert.ok(search.results.some((entry) => entry.symbol === "layeredSymbol" && entry.kind === "function"));
    assert.equal(search.receipt.layers[0].layer, "L2");
    assert.equal(search.receipt.layers[0].indexHit, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("dirty Snapshot delta reuses unchanged L1/L2 records and tombstones stale content", async () => {
  const fixture = await createProjectCodeFixture();
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-delta-root-"));
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const firstSnapshot = await builder.build(fixture);
    const store = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
    const first = await store.ensureLayer(firstSnapshot, "L2");
    await writeFile(join(fixture.directory, "Sources/App.swift"), "struct SearchFixture {\n  func changedNeedle() {}\n}\n");
    const secondSnapshot = await builder.build(fixture);
    const secondCatalog = await store.ensureLayer(secondSnapshot, "L1");
    const second = await store.ensureLayer(secondSnapshot, "L2");
    assert.notEqual(first.index.generationHash, second.index.generationHash);
    assert.ok(secondCatalog.index.reusedFileCount >= 1);
    assert.ok(second.index.reusedFileCount >= 1);
    const hits = (await new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore: store }).search({
      snapshot: secondSnapshot, sessionContext: fixture.sessionContext, searchScenarioId: "delta", query: "changedNeedle", mode: "symbols"
    })).results;
    assert.ok(hits.some((entry) => entry.symbol === "changedNeedle"));
    assert.equal(hits.some((entry) => entry.symbol === "exactNeedle"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("search and point-read reject a stale dirty overlay instead of silently refreshing fingerprint", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    await writeFile(join(fixture.directory, "Sources/App.swift"), "struct ChangedAfterSnapshot {}\n");
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder });
    const result = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "stale", query: "Changed", mode: "exact" });
    assert.equal(result.receipt.outcome, "failed");
    assert.equal(result.receipt.errorCode, "SOURCE_SNAPSHOT_STALE");
    await assert.rejects(() => service.pointRead({ snapshot, sessionContext: fixture.sessionContext, path: "Sources/App.swift" }),
      (error) => error.code === "SOURCE_SNAPSHOT_STALE");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("L3 is capability gated, isolated, cleaned and closes one runId", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Sources/App.swift": "struct ConceptualCoordinator {}\n" } });
  const calls = [];
  const runId = "run:semantic-test";
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const isolation = formalRunIsolationPort(snapshot, fixture.sessionContext, {
      calls,
      runId,
      results: [{ path: "Sources/App.swift", line: 1, kind: "semantic", score: 0.9, snippet: "struct ConceptualCoordinator {}" }]
    });
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, runIsolationPort: isolation.port });
    const result = await service.search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "l3-concept", query: "coordination concept", mode: "semantic",
      toolsetValidationReceipt: toolsetReceiptFor(snapshot), toolsetRequired: true
    });
    assert.deepEqual(calls.map(([name]) => name), ["prepare", "execute", "cleanup"]);
    assert.equal(result.receipt.runId, runId);
    assert.equal(result.receipt.runIsolationReceiptRef.runId, runId);
    assert.equal(result.receipt.cleanupReceiptRef.runId, runId);
    assert.equal(result.receipt.layers.at(-1).layer, "L3");
    assert.equal(result.receipt.layers.at(-1).isolationRequired, true);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("semantic search fails closed when local per-language capability is unavailable", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder });
    const result = await service.search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "l3-disabled", query: "concept", mode: "semantic"
    });
    assert.equal(result.receipt.outcome, "failed");
    assert.equal(result.receipt.errorCode, "SEMANTIC_LANGUAGE_UNVALIDATED");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
