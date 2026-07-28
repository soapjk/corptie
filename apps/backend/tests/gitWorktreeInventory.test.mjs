import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createGitWorkspaceSnapshot,
  inspectGitWorkspace,
  listGitWorktrees,
  parseGitWorktreePorcelain
} from "../src/utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

test("parseGitWorktreePorcelain preserves paths that contain spaces and newlines", () => {
  const input = Buffer.from([
    "worktree /tmp/main repo",
    "HEAD 0123456789abcdef",
    "branch refs/heads/main",
    "",
    "worktree /tmp/feature\nworktree",
    "HEAD fedcba9876543210",
    "detached",
    "locked maintenance window",
    "prunable gitdir file points to non-existent location",
    "future-field future value",
    "",
    ""
  ].join("\0"));

  assert.deepEqual(parseGitWorktreePorcelain(input), [
    {
      path: "/tmp/main repo",
      headOid: "0123456789abcdef",
      branchRef: "refs/heads/main",
      branchName: "main",
      isDetached: false,
      isBare: false,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null,
      unknownFields: []
    },
    {
      path: "/tmp/feature\nworktree",
      headOid: "fedcba9876543210",
      branchRef: null,
      branchName: null,
      isDetached: true,
      isBare: false,
      isLocked: true,
      lockReason: "maintenance window",
      isPrunable: true,
      pruneReason: "gitdir file points to non-existent location",
      unknownFields: [{ key: "future-field", value: "future value" }]
    }
  ]);
});

test("parseGitWorktreePorcelain retains records without a trailing empty field", () => {
  assert.deepEqual(
    parseGitWorktreePorcelain("worktree /tmp/repo\0bare\0"),
    [{
      path: "/tmp/repo",
      headOid: null,
      branchRef: null,
      branchName: null,
      isDetached: false,
      isBare: true,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null,
      unknownFields: []
    }]
  );
});

test("listGitWorktrees invokes git with NUL-delimited porcelain output", async () => {
  const calls = [];
  const records = await listGitWorktrees("/tmp/repo with space", {
    execFile: async (...args) => {
      calls.push(args);
      return {
        stdout: Buffer.from("worktree /tmp/repo with space\0HEAD abc123\0branch refs/heads/main\0\0")
      };
    }
  });

  assert.deepEqual(calls[0][0], "git");
  assert.deepEqual(calls[0][1], [
    "-C",
    "/tmp/repo with space",
    "worktree",
    "list",
    "--porcelain",
    "-z"
  ]);
  assert.equal(calls[0][2].encoding, null);
  assert.equal(records[0].branchName, "main");
});

test("inspectGitWorkspace gives linked worktrees one repository identity and distinct worktree identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-worktree-identity-"));
  const repository = join(directory, "main repo");
  const linked = join(directory, "feature worktree");
  try {
    await mkdir(repository);
    await git(["init", "-b", "main"], repository);
    await git(["commit", "--allow-empty", "-m", "initial"], repository);
    await git(["worktree", "add", "-b", "feature/identity", linked], repository);

    const mainIdentity = await inspectGitWorkspace(repository);
    const linkedIdentity = await inspectGitWorkspace(linked);
    assert.equal(mainIdentity.repositoryId, linkedIdentity.repositoryId);
    assert.notEqual(mainIdentity.worktreeId, linkedIdentity.worktreeId);
    assert.equal(mainIdentity.isMain, true);
    assert.equal(linkedIdentity.isMain, false);
    assert.equal(mainIdentity.commonGitDirCanonicalPath, linkedIdentity.commonGitDirCanonicalPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createGitWorkspaceSnapshot captures every worktree with a stable inventory version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-worktree-snapshot-"));
  const repository = join(directory, "main");
  const linked = join(directory, "linked");
  try {
    await mkdir(repository);
    await git(["init", "-b", "main"], repository);
    await git(["commit", "--allow-empty", "-m", "initial"], repository);
    await git(["worktree", "add", "-b", "feature/snapshot", linked], repository);

    const first = await createGitWorkspaceSnapshot(repository, {
      inspectedAt: "2026-07-28T00:00:00.000Z"
    });
    const second = await createGitWorkspaceSnapshot(linked, {
      inspectedAt: "2026-07-28T00:01:00.000Z"
    });
    assert.equal(first.repository.id, second.repository.id);
    assert.equal(first.inventoryVersion, second.inventoryVersion);
    assert.equal(first.worktrees.length, 2);
    assert.deepEqual(first.worktrees.map((entry) => entry.availability), ["available", "available"]);
    assert.deepEqual(
      new Set(first.worktrees.map((entry) => entry.branchName)),
      new Set(["main", "feature/snapshot"])
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function git(arguments_, cwd) {
  await execFileAsync("git", ["-C", cwd, ...arguments_], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Corptie Tests",
      GIT_AUTHOR_EMAIL: "tests@corptie.local",
      GIT_COMMITTER_NAME: "Corptie Tests",
      GIT_COMMITTER_EMAIL: "tests@corptie.local"
    }
  });
}
