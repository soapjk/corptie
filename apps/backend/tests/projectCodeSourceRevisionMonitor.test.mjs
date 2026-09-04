import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadProjectCodeSourceJournalPort } from "../src/project-code/projectCodeSourceJournalPort.mjs";
import { ProjectCodeSourceRevisionMonitor } from "../src/project-code/projectCodeSourceRevisionMonitor.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";

const execFileAsync = promisify(execFile);

test("revision lease detects a change between query barriers without a full validation", async () => {
  const port = fakeJournalPort();
  const monitor = new ProjectCodeSourceRevisionMonitor({ port });
  const snapshot = fixtureSnapshot();
  let fullValidations = 0;
  const builder = { assertCurrent: async () => { fullValidations += 1; return true; } };
  const established = await monitor.establish({
    worktreeId: "worktree:test", canonicalRoot: "/tmp/project-code-monitor",
    build: async () => snapshot, verify: (value) => builder.assertCurrent(value)
  });
  assert.equal(fullValidations, 1, "baseline establishment performs one authoritative validation");
  const lease = monitor.lease(established, builder);
  await lease.verifyBefore();
  port.bump("/tmp/project-code-monitor");
  await assert.rejects(() => lease.verifyAfter(), (error) => error.code === "SOURCE_SNAPSHOT_STALE");
  assert.equal(fullValidations, 1, "trusted barriers do not rescan Git or source files");
  assert.equal(monitor.summary().invalidations, 1);
});

test("uncertain journals fail over to the existing full validation path", async () => {
  const port = fakeJournalPort();
  const monitor = new ProjectCodeSourceRevisionMonitor({ port });
  const snapshot = fixtureSnapshot();
  let fullValidations = 0;
  const builder = { assertCurrent: async () => { fullValidations += 1; return true; } };
  await monitor.establish({ worktreeId: "worktree:test", canonicalRoot: "/tmp/project-code-monitor",
    build: async () => snapshot, verify: (value) => builder.assertCurrent(value) });
  port.markUncertain();
  const lease = monitor.lease(snapshot, builder);
  await lease.verifyBefore();
  await lease.verifyAfter();
  assert.equal(fullValidations, 3);
  assert.equal(monitor.summary().fullFallbacks, 1);
});

test("native vnode journal observes immediate writes, additions and removals with bounded barriers", { skip: process.platform !== "darwin" }, async (context) => {
  const port = loadProjectCodeSourceJournalPort();
  if (!port) return context.skip("native journal module is unavailable");
  const root = await mkdtemp(join(tmpdir(), "corptie-vnode-journal-"));
  const file = join(root, "watched.txt");
  await writeFile(file, "initial");
  const journal = port.open(root);
  try {
    port.reset(journal, [file]);
    let epoch = BigInt(port.barrier(journal).epoch);
    const samples = [];
    for (let index = 0; index < 100; index += 1) {
      await writeFile(file, String(index));
      const started = performance.now();
      const next = BigInt(port.barrier(journal).epoch);
      samples.push(performance.now() - started);
      assert.ok(next > epoch, `write ${index} was not observed`);
      epoch = next;
    }
    const added = join(root, "added.txt");
    await writeFile(added, "new");
    let next = BigInt(port.barrier(journal).epoch);
    assert.ok(next > epoch, "root directory watch must observe additions");
    epoch = next;
    await rm(file);
    next = BigInt(port.barrier(journal).epoch);
    assert.ok(next > epoch, "file and directory watches must observe removals");
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    context.diagnostic(`native vnode barrier p95=${p95.toFixed(4)}ms`);
    assert.ok(p95 < 5, `native vnode barrier p95=${p95}ms`);
  } finally {
    port.close(journal);
    await rm(root, { recursive: true, force: true });
  }
});

test("native monitor invalidates a Snapshot when its Git branch ref advances", { skip: process.platform !== "darwin" }, async (context) => {
  if (!loadProjectCodeSourceJournalPort()) return context.skip("native journal module is unavailable");
  const fixture = await createProjectCodeFixture();
  const monitor = new ProjectCodeSourceRevisionMonitor();
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const snapshot = await monitor.establish({
      worktreeId: fixture.binding.worktreeId,
      canonicalRoot: fixture.directory,
      build: () => builder.build(fixture),
      verify: (value) => builder.assertCurrent(value)
    });
    const lease = monitor.lease(snapshot, builder);
    await lease.verifyBefore();
    await execFileAsync("git", ["commit", "--allow-empty", "-qm", "advance ref"], { cwd: fixture.directory });
    await assert.rejects(() => lease.verifyAfter(), (error) => error.code === "SOURCE_SNAPSHOT_STALE");
  } finally {
    monitor.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

function fixtureSnapshot() {
  return {
    receipt: { sourceFingerprint: "a".repeat(64) },
    candidates: [{ absolutePath: "/tmp/project-code-monitor/source.js" }],
    ignoreConfigSources: [],
    startupReceipt: { headIdentity: { kind: "branch", branch: "main" } },
    workspaceIdentity: {
      gitDirCanonicalPath: "/tmp/project-code-monitor-git",
      commonGitDirCanonicalPath: "/tmp/project-code-monitor-git"
    }
  };
}

function fakeJournalPort() {
  const journals = new Map();
  let uncertain = false;
  return {
    capability: "fake-journal/v1",
    open(root) { const journal = { root, trusted: true }; journals.set(root, { epoch: 0 }); return journal; },
    reset(journal) { const value = journals.get(journal.root); value.epoch += 1; return fact(value, uncertain); },
    barrier(journal) { return fact(journals.get(journal.root), uncertain); },
    close(journal) { journals.delete(journal.root); },
    bump(root) { journals.get(root).epoch += 1; },
    markUncertain() { uncertain = true; }
  };
}

function fact(value, uncertain) {
  return { epoch: String(value.epoch), eventId: String(value.epoch), trusted: !uncertain, errorCode: uncertain ? "SOURCE_JOURNAL_UNCERTAIN" : null };
}
