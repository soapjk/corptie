import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProjectCodeIndexStore } from "../src/project-code/projectCodeIndexStore.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeQueryLimiter, ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";

test("L0 warm latency stays bounded and never opens an index generation", async (context) => {
  const fixture = await createProjectCodeFixture();
  let indexCalls = 0;
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore: { ensureLayer() { indexCalls += 1; } } });
  const samples = [];
    const layerSamples = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: `warm-${index}`, query: "exactNeedle", mode: "exact" });
      samples.push(result.receipt.latency.totalMs);
      layerSamples.push(result.receipt.latency.layerMs.L0);
    }
    samples.sort((a, b) => a - b);
    layerSamples.sort((a, b) => a - b);
    const totalP95 = samples[Math.ceil(samples.length * 0.95) - 1];
    const layerP95 = layerSamples[Math.ceil(layerSamples.length * 0.95) - 1];
    context.diagnostic(`L0 warm total p95=${totalP95}ms, rg layer p95=${layerP95}ms, index opens=${indexCalls}`);
    assert.ok(totalP95 <= 500, `warm total p95=${totalP95}ms`);
    assert.ok(layerP95 <= 300, `warm rg layer p95=${layerP95}ms`);
    assert.equal(indexCalls, 0);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("in-flight cancellation is observed within the bounded subprocess path", async () => {
  const fixture = await createProjectCodeFixture();
  const tools = await mkdtemp(join(tmpdir(), "corptie-fake-rg-"));
  const fakeRg = join(tools, "rg");
  await writeFile(fakeRg, "#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n");
  await chmod(fakeRg, 0o700);
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, rgPath: fakeRg });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = performance.now();
    const result = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "cancel-running",
      query: "needle", mode: "exact", signal: controller.signal });
    assert.equal(result.receipt.outcome, "cancelled");
    assert.ok(performance.now() - started < 500);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(tools, { recursive: true, force: true });
  }
});

test("query limiter enforces per-Session concurrency and bounded queue backpressure", async () => {
  const limiter = new ProjectCodeQueryLimiter({ perSession: 2, global: 8, queueTimeoutMs: 20 });
  const first = await limiter.acquire("logical:test");
  const second = await limiter.acquire("logical:test");
  await assert.rejects(() => limiter.acquire("logical:test"), (error) => error.code === "QUERY_BUSY");
  first(); second();
});

test("capacity limit fails closed after verified external-root staging", async () => {
  const fixture = await createProjectCodeFixture();
  const dataRoot = await mkdtemp(join(tmpdir(), "corptie-capacity-root-"));
  try {
    const snapshot = await new RepositorySourceSnapshotBuilder().build(fixture);
    const store = new ProjectCodeIndexStore({ dataRoot, requireExternal: false, maxBytes: 1 });
    await assert.rejects(() => store.ensureLayer(snapshot, "L1"), (error) => error.code === "REPOSITORY_LIMIT");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
