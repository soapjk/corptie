import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProjectCodeIndexStore } from "../src/project-code/projectCodeIndexStore.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { validateProjectCodeReceipt } from "../src/project-code/projectCodeContracts.mjs";
import { defaultExclusionReason } from "../src/project-code/projectCodePaths.mjs";
import { createProjectCodeFixture, formalRunIsolationPort, toolsetReceiptFor } from "./helpers/projectCodeTestFixture.mjs";

test("project Toolset declarations are excluded from source fingerprinting", () => {
  assert.equal(defaultExclusionReason(".corptie/project-toolset/declaration.json"), "DEFAULT_EXCLUDED_SPACE");
  assert.equal(defaultExclusionReason(".corptie/project-toolset/active.json"), "DEFAULT_EXCLUDED_SPACE");
});

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

test("production non-blocking L2 returns rg results while one background index warmup completes", async () => {
  const fixture = await createProjectCodeFixture();
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-nonblocking-index-"));
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const store = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
    const service = new ProjectCodeSearchService({
      snapshotBuilder: builder,
      indexStore: store,
      nonBlockingIndexWarmup: true
    });
    const first = await service.search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "nonblocking-first",
      query: "layeredSymbol", mode: "symbols"
    });
    assert.ok(first.results.some((entry) => entry.path === "Sources/tool.ts"));
    assert.equal(first.receipt.layers[0].layer, "L2");
    assert.equal(first.receipt.layers[0].status, "skipped");
    assert.equal(first.receipt.layers[0].skippedReason, "INDEX_WARMING");
    assert.equal(first.receipt.layers[1].layer, "L0");
    await store.warmLayer(snapshot, "L2");
    const second = await service.search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "nonblocking-second",
      query: "layeredSymbol", mode: "symbols"
    });
    assert.equal(second.receipt.layers[0].layer, "L2");
    assert.equal(second.receipt.layers[0].status, "executed");
    assert.ok(second.results.some((entry) => entry.symbol === "layeredSymbol"));
    assert.equal(store.stats.l2Builds, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("auto search never waits for an unfinished L1 or L2 warmup", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const never = new Promise(() => {});
    const warmingStore = {
      readyLayer: () => null,
      warmLayer: () => never
    };
    const service = new ProjectCodeSearchService({
      snapshotBuilder: builder,
      indexStore: warmingStore,
      nonBlockingIndexWarmup: true
    });
    let timeout;
    const result = await Promise.race([
      service.search({ snapshot, sessionContext: fixture.sessionContext,
        searchScenarioId: "nonblocking-auto", query: "missingSymbol", mode: "auto" }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("search waited for index warmup")), 500); })
    ]).finally(() => clearTimeout(timeout));
    assert.equal(result.receipt.layers.some((layer) => layer.skippedReason === "INDEX_WARMING"), true);
    assert.equal(result.receipt.layers.some((layer) => layer.layer === "L1" && layer.degradedReason === "INDEX_WARMING"), true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("IndexStore initializes a missing dedicated child under a verified writable parent", async () => {
  const fixture = await createProjectCodeFixture();
  const parent = await mkdtemp(join(tmpdir(), "corptie-index-parent-"));
  const dataRoot = join(parent, "project-code-index");
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const store = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
    const [readiness, built] = await Promise.all([store.initialize(), store.ensureLayer(snapshot, "L2")]);
    assert.equal(readiness.status, "ready");
    assert.equal(store.getReadiness().status, "ready");
    assert.ok(built.index.documents.length > 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("directory scopes expand only Snapshot candidates and point-read reaches deep UTF-8 lines", async () => {
  const deep = Array.from({ length: 5000 }, (_, index) => `第${index + 1}行 ${index === 4320 ? "deepNeedle" : "padding"}`).join("\n");
  const fixture = await createProjectCodeFixture({ files: {
    "Sources/Deep.swift": deep,
    "Other/Outside.swift": "let deepNeedle = false\n",
    ".gitignore": ".build/\n"
  } });
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-directory-scope-"));
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder,
      indexStore: new ProjectCodeIndexStore({ dataRoot, requireExternal: false }) });
    const exact = await service.search({ snapshot, sessionContext: fixture.sessionContext,
      searchScenarioId: "directory-exact", query: "deepNeedle", mode: "exact", paths: ["Sources"] });
    assert.deepEqual(exact.results.map((entry) => entry.path), ["Sources/Deep.swift"]);
    const symbols = await service.search({ snapshot, sessionContext: fixture.sessionContext,
      searchScenarioId: "directory-symbols", query: "deepNeedle", mode: "symbols", paths: ["Sources"] });
    assert.equal(symbols.results.every((entry) => entry.path.startsWith("Sources/")), true);
    const window = await service.pointRead({ snapshot, sessionContext: fixture.sessionContext,
      path: "Sources/Deep.swift", startLine: 4318, lineCount: 6, maxBytes: 4096 });
    assert.equal(window.lines[3].includes("deepNeedle"), true);
    assert.equal(window.nextStartLine, 4324);
    assert.equal(window.truncatedReason, "line_count");
    assert.equal(window.eof, false);
    await assert.rejects(() => service.pointRead({ snapshot, sessionContext: fixture.sessionContext,
      path: "Sources/Deep.swift", startLine: 4318, maxScanBytes: 128 }),
    (error) => error.code === "POINT_READ_SCAN_LIMIT");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("SQLite v5 inverted index returns symbols, callers, imports, and Chinese requirement Top-5 results", async () => {
  const fixture = await createProjectCodeFixture({ files: {
    "Sources/SessionViewportController.swift": "final class SessionViewportController {\n  func restorePositionAfterHydration() {}\n}\n",
    "Sources/TaskService.ts": "import { startupCoordinator } from './startupCoordinator';\nexport function createAndStartTask() { startupCoordinator(); }\nexport function invokeTask() { createAndStartTask(); }\nexport function taskExecutionPrompt(description: string) { return `context ${description}`; }\n",
    ".gitignore": ".build/\n"
  } });
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-v5-index-"));
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const store = new ProjectCodeIndexStore({ dataRoot, requireExternal: false });
    const built = await store.ensureLayer(snapshot, "L2");
    assert.equal(built.index.schemaVersion, 5);
    await access(built.index.databasePath);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore: store });
    const callers = await service.search({ snapshot, sessionContext: fixture.sessionContext,
      searchScenarioId: "callers", query: "谁调用 createAndStartTask", mode: "symbols" });
    assert.ok(callers.results.some((entry) => entry.kind === "call" && entry.line === 3));
    const imported = await service.search({ snapshot, sessionContext: fixture.sessionContext,
      searchScenarioId: "imports", query: "startupCoordinator", mode: "symbols" });
    assert.ok(imported.results.some((entry) => entry.kind === "import" && entry.line === 1));
    const goldens = [
      ["恢复会话上次阅读位置", "SessionViewportController.swift"],
      ["创建任务后立即启动工作会话", "TaskService.ts"],
      ["描述只放上下文不要发成消息", "TaskService.ts"]
    ];
    for (const [query, expected] of goldens) {
      const result = await service.search({ snapshot, sessionContext: fixture.sessionContext,
        searchScenarioId: `golden-${expected}-${query.length}`, query, mode: "auto", limit: 5 });
      assert.ok(result.results.slice(0, 5).some((entry) => entry.path.endsWith(expected)), `${query}: ${JSON.stringify(result.results)}`);
      assert.equal(result.receipt.layers[0].layer, "L2", "natural-language auto queries must not waste an exact-rg pass");
    }
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

test("warm freshness rejects a new ignore source outside declared search paths", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build({ ...fixture, sourceDeclarations: [{ path: "Sources", language: "swift" }] });
    await mkdir(join(fixture.directory, "Other"));
    await writeFile(join(fixture.directory, "Other/.gitignore"), "secret.txt\n");
    await assert.rejects(() => builder.assertCurrent(snapshot), (error) => error.code === "SOURCE_SNAPSHOT_STALE");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("warm freshness revalidates the exact Git marker identity without trusting the cached anchor", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const mismatched = {
      ...snapshot,
      workspaceIdentity: { ...snapshot.workspaceIdentity, gitDirCanonicalPath: join(fixture.directory, ".git-other") }
    };
    await assert.rejects(() => builder.assertCurrent(mismatched), (error) => error.code === "STARTUP_BINDING_MISMATCH");
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
