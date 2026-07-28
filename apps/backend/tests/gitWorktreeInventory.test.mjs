import assert from "node:assert/strict";
import test from "node:test";
import { listGitWorktrees, parseGitWorktreePorcelain } from "../src/utils/gitWorktreeInventory.mjs";

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
