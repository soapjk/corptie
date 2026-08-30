import assert from "node:assert/strict";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { hashCanonical } from "../src/project-code/projectCodeContracts.mjs";
import { defaultExclusionReason } from "../src/project-code/projectCodePaths.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { createProjectCodeFixture, git } from "./helpers/projectCodeTestFixture.mjs";

test("source-fingerprint/v2 covers repository/worktree, commit/tree, overlay and ignore revision", async () => {
  const fixture = await createProjectCodeFixture({ files: {
    "keep.swift": "struct Keep {}\n",
    "modify.swift": "struct Before {}\n",
    "delete.swift": "struct Delete {}\n",
    "rename.swift": "struct Rename {}\n",
    ".gitignore": "ignored/\n"
  } });
  try {
    await writeFile(join(fixture.directory, "modify.swift"), "struct After {}\n");
    await unlink(join(fixture.directory, "delete.swift"));
    await rename(join(fixture.directory, "rename.swift"), join(fixture.directory, "renamed.swift"));
    await writeFile(join(fixture.directory, "added.swift"), "struct Added {}\n");
    await git(fixture.directory, ["add", "-A"]);
    const snapshot = await new RepositorySourceSnapshotBuilder().build(fixture);
    assert.equal(snapshot.fingerprintPayload.schemaVersion, "source-fingerprint/v2");
    assert.equal(snapshot.fingerprintPayload.repositoryId, fixture.identity.repositoryId);
    assert.equal(snapshot.fingerprintPayload.worktreeId, fixture.identity.worktreeId);
    assert.equal(snapshot.fingerprintPayload.commitOid, fixture.commitOid);
    assert.equal(snapshot.fingerprintPayload.treeOid, fixture.treeOid);
    assert.equal(snapshot.receipt.sourceFingerprint, hashCanonical(snapshot.fingerprintPayload));
    assert.match(snapshot.receipt.sourceFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(snapshot.overlayEntries.some((entry) => entry.path === "delete.swift" && entry.state === "tombstone"));
    assert.ok(snapshot.overlayEntries.some((entry) => entry.path === "rename.swift" && entry.state === "tombstone" && entry.renameGroupId));
    assert.ok(snapshot.overlayEntries.some((entry) => entry.path === "renamed.swift" && entry.state === "rename" && entry.renameGroupId));
    assert.ok(snapshot.overlayEntries.some((entry) => entry.path === "added.swift" && entry.state === "add"));

    const prior = snapshot.receipt.sourceFingerprint;
    await writeFile(join(fixture.directory, ".gitignore"), "ignored/\ncache/\n");
    const changed = await new RepositorySourceSnapshotBuilder().build(fixture);
    assert.notEqual(changed.receipt.sourceFingerprint, prior);
    assert.notEqual(changed.receipt.ignoreConfigRevisionRef.revisionHash, snapshot.receipt.ignoreConfigRevisionRef.revisionHash);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("source-fingerprint/v2 RFC 8785 golden vector is stable", () => {
  const payload = {
    schemaVersion: "source-fingerprint/v2",
    repositoryId: "repository:golden",
    worktreeId: "worktree:golden",
    commitOid: "1".repeat(40),
    treeOid: "2".repeat(40),
    overlayManifest: [{ path: "A.swift", state: "modify", oldPath: null, mode: "100644", byteLength: 3,
      contentHash: "3".repeat(64), stageState: ".M", renameGroupId: null }],
    ignoreConfigRevision: { schemaVersion: "project-code-exclusions/v4", sources: [], declarationsHash: "4".repeat(64) }
  };
  assert.equal(hashCanonical(payload), "eeca7be926e41392f12330044ce66f723b40a91f916bd06d99e9c71a0fdbabe8");
});

test("same tree and overlay remain distinct across authoritative Worktrees", async () => {
  const fixture = await createProjectCodeFixture();
  const linked = `${fixture.directory}-linked`;
  try {
    await git(fixture.directory, ["worktree", "add", "-q", "--detach", linked, "HEAD"]);
    const second = await createFixtureView(linked, fixture.sessionContext);
    const firstSnapshot = await new RepositorySourceSnapshotBuilder().build(fixture);
    const secondSnapshot = await new RepositorySourceSnapshotBuilder().build(second);
    assert.equal(firstSnapshot.receipt.sourceCommitOid, secondSnapshot.receipt.sourceCommitOid);
    assert.equal(firstSnapshot.receipt.sourceTreeOid, secondSnapshot.receipt.sourceTreeOid);
    assert.notEqual(firstSnapshot.receipt.worktreeId, secondSnapshot.receipt.worktreeId);
    assert.notEqual(firstSnapshot.receipt.sourceFingerprint, secondSnapshot.receipt.sourceFingerprint);
  } finally {
    await git(fixture.directory, ["worktree", "remove", "--force", linked]).catch(() => {});
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Toolset-owned .corptie state cannot invalidate its authoritative source fingerprint", async () => {
  const fixture = await createProjectCodeFixture({ files: { "Package.swift": "// source\n" } });
  try {
    const builder = new RepositorySourceSnapshotBuilder();
    const before = await builder.build(fixture);
    await mkdir(join(fixture.directory, ".corptie/project-toolset/generated"), { recursive: true });
    await writeFile(join(fixture.directory, ".corptie/project-toolset/active.json"), '{"receiptId":"toolset_validation_receipt:test"}\n');
    await writeFile(join(fixture.directory, ".corptie/project-toolset/generated/candidate.json"), "{}\n");
    const after = await builder.build(fixture);
    assert.equal(after.receipt.sourceFingerprint, before.receipt.sourceFingerprint);
    assert.equal(defaultExclusionReason(".corptie/project-toolset/active.json"), "DEFAULT_EXCLUDED_SPACE");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixtureView(directory, sessionContext) {
  const { inspectGitWorkspace } = await import("../src/utils/gitWorktreeInventory.mjs");
  const { startupReceiptFor } = await import("./helpers/projectCodeTestFixture.mjs");
  const identity = await inspectGitWorkspace(directory);
  const commitOid = await git(directory, ["rev-parse", "HEAD"]);
  const treeOid = await git(directory, ["rev-parse", "HEAD^{tree}"]);
  const binding = { repositoryId: identity.repositoryId, worktreeId: identity.worktreeId, canonicalWorktreePath: identity.canonicalPath,
    providerBindingId: "provider_binding:second", bindingGeneration: 1, repositoryInventoryVersion: "inventory:second", workspaceResourceVersion: 1, resourceVersion: 1 };
  return { directory, identity, commitOid, treeOid, sessionContext, binding,
    startupReceipt: startupReceiptFor({ identity, commitOid, treeOid, sessionContext, binding }) };
}
