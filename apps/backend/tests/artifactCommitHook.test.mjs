import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { ensureArtifactCommitHook } from "../src/runtime/artifactCommitHook.mjs";

test("Artifact hook migration never mirrors arbitrary project entries from a relative hooksPath", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-artifact-hook-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    const legacy = join(root, "corptie-artifact-hooks");
    await mkdir(join(legacy, "apps"), { recursive: true });
    await writeFile(join(legacy, ".gitignore"), "self-loop sentinel\n");
    await writeFile(join(legacy, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    git("config", "--local", "core.hooksPath", "corptie-artifact-hooks");

    await ensureArtifactCommitHook(root, { dbPath: join(root, "evidence.sqlite") });
    const configured = git("config", "--local", "--get", "core.hooksPath");
    assert.equal(basename(configured), "corptie-managed-artifact-hooks-v2");
    const names = (await readdir(configured)).sort();
    assert.deepEqual(names, ["pre-applypatch", "pre-commit", "pre-merge-commit", "pre-push"]);
    assert.deepEqual((await readdir(legacy)).sort(), [".gitignore", "apps", "pre-push"]);

    await ensureArtifactCommitHook(root, { dbPath: join(root, "evidence.sqlite") });
    assert.deepEqual((await readdir(configured)).sort(), names);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
