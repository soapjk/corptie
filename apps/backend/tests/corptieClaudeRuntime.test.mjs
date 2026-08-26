import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureCorptieClaudeRuntime } from "../src/runtime/corptieClaudeRuntime.mjs";

test("Claude runtime installs the Corptie collaboration Skill as a local plugin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-claude-runtime-"));
  const bundledSkillPath = join(directory, "source", "SKILL.md");
  const bundledReferencePath = join(directory, "source", "project-tools-set.md");
  const bundledMemoryPath = join(directory, "source", "global-instructions.md");
  const sourceCredentialsPath = join(directory, "native-claude", ".credentials.json");
  await mkdir(join(directory, "source"), { recursive: true });
  await mkdir(join(directory, "native-claude"), { recursive: true });
  await writeFile(bundledSkillPath, "---\nname: corptie-collaboration\n---\n", "utf8");
  await writeFile(bundledReferencePath, "# Project tools\n", "utf8");
  await writeFile(bundledMemoryPath, "# Shared memory\n\nEnvironment: {{CORPTIE_ENVIRONMENT}}\n", "utf8");
  await writeFile(sourceCredentialsPath, "{\"token\":\"test\"}\n", "utf8");

  try {
    const runtime = await ensureCorptieClaudeRuntime({
      homeDir: directory,
      environmentName: "development",
      bundledMemoryPath,
      bundledSkillPath,
      bundledProjectToolsReferencePath: bundledReferencePath,
      sourceCredentialsPath
    });

    const manifest = JSON.parse(await readFile(runtime.manifestPath, "utf8"));
    assert.equal(manifest.name, "corptie-runtime");
    assert.match(await readFile(runtime.skillPath, "utf8"), /corptie-collaboration/);
    assert.equal(await readFile(runtime.projectToolsReferencePath, "utf8"), "# Project tools\n");
    assert.equal(runtime.pluginAvailable, true);
    assert.equal(runtime.skillAvailable, true);
    assert.equal(runtime.memoryAvailable, true);
    assert.equal(runtime.credentialsCopied, true);
    assert.equal(await readFile(runtime.credentialsPath, "utf8"), "{\"token\":\"test\"}\n");
    assert.equal((await lstat(runtime.claudeMemoryPath)).isSymbolicLink(), true);
    assert.equal(await realpath(runtime.claudeMemoryPath), await realpath(runtime.sharedMemoryPath));
    assert.match(await readFile(runtime.claudeMemoryPath, "utf8"), /Environment: development/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
