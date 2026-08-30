import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ProjectCodeIndexStore } from "../src/project-code/projectCodeIndexStore.mjs";
import { assertContainedRegularPath } from "../src/project-code/projectCodePaths.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";

test("outside paths, symlink escape, generated/dependency/build spaces are rejected and audited", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    await mkdir(join(fixture.directory, "node_modules/pkg"), { recursive: true });
    await writeFile(join(fixture.directory, "node_modules/pkg/index.js"), "needle");
    await mkdir(join(fixture.directory, "build"), { recursive: true });
    await writeFile(join(fixture.directory, "build/generated.swift"), "needle");
    await symlink("/etc/passwd", join(fixture.directory, "escape-link"));
    const snapshot = await new RepositorySourceSnapshotBuilder().build(fixture);
    assert.equal(snapshot.candidates.some((entry) => entry.path.startsWith("node_modules/")), false);
    assert.equal(snapshot.candidates.some((entry) => entry.path.startsWith("build/")), false);
    assert.ok(snapshot.rejectedPaths.some((entry) => entry.reasonCode === "SYMLINK_FORBIDDEN"));
    await assert.rejects(() => assertContainedRegularPath(fixture.directory, "escape-link"), (error) => error.code === "PATH_OUTSIDE_SCOPE");
    await assert.rejects(() => assertContainedRegularPath(fixture.directory, "../outside"), (error) => error.code === "PATH_INVALID");
    await assert.rejects(() => assertContainedRegularPath(fixture.directory, "/etc/passwd"), (error) => error.code === "PATH_INVALID" && error.rejectedPath.relativePath === null);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test("out-of-scope search paths produce rejected-path evidence without leaking absolute path", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder });
    const result = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "reject-path",
      query: "needle", mode: "exact", paths: ["/etc/passwd"] });
    assert.equal(result.receipt.outcome, "rejected");
    assert.equal(result.receipt.rejectedPaths[0].relativePath, null);
    assert.match(result.receipt.rejectedPaths[0].pathHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(result.receipt).includes("/etc/passwd"), false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("missing external dataRoot does not affect L0 but fails L2 without internal-disk fallback", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const store = new ProjectCodeIndexStore({ dataRoot: join(fixture.directory, "missing-external-root"), requireExternal: false });
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder, indexStore: store });
    const l0 = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "fault-l0", query: "exactNeedle", mode: "exact" });
    assert.equal(l0.receipt.outcome, "success");
    const l2 = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "fault-l2", query: "exactNeedle", mode: "symbols" });
    assert.equal(l2.receipt.outcome, "failed");
    assert.equal(l2.receipt.errorCode, "DATA_ROOT_UNAVAILABLE");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("pre-cancelled query yields a closed cancellation receipt", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await builder.build(fixture);
    const controller = new AbortController();
    controller.abort();
    const service = new ProjectCodeSearchService({ snapshotBuilder: builder });
    const result = await service.search({ snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "cancelled",
      query: "needle", mode: "exact", signal: controller.signal });
    assert.equal(result.receipt.outcome, "cancelled");
    assert.equal(result.receipt.cancellation.requested, true);
    assert.equal(result.receipt.cancellation.observed, true);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
