import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { ensureArtifactCommitHook, inspectArtifactCommitHook } from "../src/runtime/artifactCommitHook.mjs";

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
    assert.equal(basename(configured), "hooks");
    assert.equal(basename(dirname(configured)), "corptie-managed");
    const names = (await readdir(configured)).sort();
    assert.deepEqual(names, ["pre-applypatch", "pre-commit", "pre-merge-commit", "pre-push"]);
    assert.deepEqual((await readdir(legacy)).sort(), [".gitignore", "apps", "pre-push"]);

    await ensureArtifactCommitHook(root, { dbPath: join(root, "evidence.sqlite") });
    assert.deepEqual((await readdir(configured)).sort(), names);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact hook installation coalesces concurrent Worktree callers and writes a v2 manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-artifact-hook-concurrent-"));
  const linked = join(root, "linked");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  try {
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "Corptie Tests");
    git(root, "config", "user.email", "tests@corptie.local");
    git(root, "commit", "--allow-empty", "-m", "initial", "--quiet");
    git(root, "worktree", "add", "-b", "feature/concurrent", linked, "HEAD");
    const dbPath = join(root, "evidence.sqlite");

    const results = await Promise.all([
      ensureArtifactCommitHook(root, { dbPath }),
      ensureArtifactCommitHook(linked, { dbPath }),
      ensureArtifactCommitHook(root, { dbPath })
    ]);
    assert.equal(new Set(results.map(result => dirname(result.hooks[0].hookPath))).size, 1);
    const inspection = await inspectArtifactCommitHook(linked);
    assert.equal(inspection.installed, true);
    assert.equal(inspection.manifest.version, 2);
    assert.equal(JSON.parse(await readFile(join(dirname(inspection.expectedHooksPath), "manifests", "artifact-hook.json"), "utf8")).version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact hook migration cuts self-referencing and cyclic managed wrapper chains", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-artifact-hook-cycle-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    const legacy = join(root, ".git", "corptie-managed-artifact-hooks-v2");
    await mkdir(legacy, { recursive: true });
    const preCommit = join(legacy, "pre-commit");
    const preMerge = join(legacy, "pre-merge-commit");
    const preApply = join(legacy, "pre-applypatch");
    await writeFile(preCommit, `#!/bin/sh\n# Corptie managed Artifact commit gate v1\n# original-hook: ${JSON.stringify(preCommit)}\n`, { mode: 0o700 });
    await writeFile(preMerge, `#!/bin/sh\n# Corptie managed Artifact commit gate v1\n# original-hook: ${JSON.stringify(preApply)}\n`, { mode: 0o700 });
    await writeFile(preApply, `#!/bin/sh\n# Corptie managed Artifact commit gate v1\n# original-hook: ${JSON.stringify(preMerge)}\n`, { mode: 0o700 });
    git("config", "--local", "core.hooksPath", legacy);

    const result = await ensureArtifactCommitHook(root, {
      dbPath: join(root, "evidence.sqlite"), nodePath: "/usr/bin/true"
    });

    for (const hook of result.hooks) {
      assert.equal(hook.chainedHook, null);
      assert.match(await readFile(hook.hookPath, "utf8"), /^# original-hook: ""$/m);
    }
    assert.doesNotThrow(() => git("commit", "--allow-empty", "--no-gpg-sign", "-m", "cycle repaired"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact hook diagnostic mode never changes repository configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-artifact-hook-diagnostic-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    const inspected = await ensureArtifactCommitHook(root, {
      dbPath: join(root, "evidence.sqlite"), diagnosticOnly: true
    });
    assert.equal(inspected.installed, false);
    assert.throws(() => git("config", "--local", "--get", "core.hooksPath"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
