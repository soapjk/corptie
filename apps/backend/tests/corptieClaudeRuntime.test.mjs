import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureCorptieClaudeRuntime } from "../src/runtime/corptieClaudeRuntime.mjs";

test("Claude runtime installs the Corptie collaboration Skill as a local plugin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-claude-runtime-"));
  const bundledSkillPath = join(directory, "source", "SKILL.md");
  const bundledReferencePath = join(directory, "source", "project-tools-set.md");
  await mkdir(join(directory, "source"), { recursive: true });
  await writeFile(bundledSkillPath, "---\nname: corptie-collaboration\n---\n", "utf8");
  await writeFile(bundledReferencePath, "# Project tools\n", "utf8");

  try {
    const runtime = await ensureCorptieClaudeRuntime({
      homeDir: directory,
      environmentName: "development",
      bundledSkillPath,
      bundledProjectToolsReferencePath: bundledReferencePath
    });

    const manifest = JSON.parse(await readFile(runtime.manifestPath, "utf8"));
    assert.equal(manifest.name, "corptie-runtime");
    assert.match(await readFile(runtime.skillPath, "utf8"), /corptie-collaboration/);
    assert.equal(await readFile(runtime.projectToolsReferencePath, "utf8"), "# Project tools\n");
    assert.equal(runtime.pluginAvailable, true);
    assert.equal(runtime.skillAvailable, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
