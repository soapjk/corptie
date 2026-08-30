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
  const warmupCount = 5;
  const sampleCount = 40;
  const fixture = await createProjectCodeFixture();
  let indexCalls = 0;
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore: { ensureLayer() { indexCalls += 1; } } });
    for (let index = 0; index < warmupCount; index += 1) {
      await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: `warmup-${index}`, query: "exactNeedle", mode: "exact" });
    }
    const totalSamples = [];
    const rgSamples = [];
    const snapshotVerifySamples = [];
    const schemaIdentitySamples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const result = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: `warm-${index}`, query: "exactNeedle", mode: "exact" });
      totalSamples.push(result.receipt.latency.totalMs);
      rgSamples.push(result.receipt.latency.layerMs.L0);
      snapshotVerifySamples.push(result.receipt.latency.snapshotVerifyMs);
      schemaIdentitySamples.push(result.receipt.latency.bindingVerifyMs);
    }
    const totalP95 = nearestRankPercentile(totalSamples, 0.95);
    const rgP95 = nearestRankPercentile(rgSamples, 0.95);
    const snapshotVerifyP95 = nearestRankPercentile(snapshotVerifySamples, 0.95);
    const schemaIdentityP95 = nearestRankPercentile(schemaIdentitySamples, 0.95);
    context.diagnostic(`L0 warm samples=${sampleCount} after warmup=${warmupCount}; nearest-rank p95: total=${totalP95}ms, rg=${rgP95}ms, snapshot verify=${snapshotVerifyP95}ms, schema/identity=${schemaIdentityP95}ms; index opens=${indexCalls}`);
    assert.ok(totalP95 <= 500, `warm total p95=${totalP95}ms`);
    assert.ok(rgP95 <= 300, `warm rg layer p95=${rgP95}ms`);
    assert.ok(snapshotVerifyP95 <= 300, `warm snapshot verify p95=${snapshotVerifyP95}ms`);
    assert.equal(indexCalls, 0);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

function nearestRankPercentile(values, percentile) {
  assert.ok(values.length >= 20, "performance percentiles require at least 20 measured warm samples");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentile) - 1];
}

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
