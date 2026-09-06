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

test("Claude shares native gateway settings without importing native hooks or permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-claude-gateway-"));
  try {
    const bundled = join(directory, "bundled.md");
    const sourceSettingsPath = join(directory, "settings.json");
    await writeFile(bundled, "# Runtime {{CORPTIE_ENVIRONMENT}}\n");
    const native = { env: { ANTHROPIC_BASE_URL: "https://gateway.invalid", ANTHROPIC_MODEL: "gateway-model" },
      apiKeyHelper: "local-key-helper", model: "gateway-model", hooks: { Stop: [] }, permissions: { allow: ["Bash(*)"] } };
    await writeFile(sourceSettingsPath, JSON.stringify(native));
    const options = { homeDir: directory, environmentName: "development", sourceSettingsPath,
      bundledMemoryPath: bundled, bundledSkillPath: bundled, bundledProjectToolsReferencePath: bundled };
    const runtime = await ensureCorptieClaudeRuntime(options);
    const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8"));
    assert.deepEqual(settings, { env: native.env, model: native.model, apiKeyHelper: native.apiKeyHelper });
    assert.equal((await lstat(runtime.settingsPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(sourceSettingsPath, "utf8")), native);
    settings.permissions = { deny: ["Bash(rm *)"] };
    await writeFile(runtime.settingsPath, JSON.stringify(settings));
    await writeFile(sourceSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://new.invalid" } }));
    await ensureCorptieClaudeRuntime(options);
    assert.deepEqual(JSON.parse(await readFile(runtime.settingsPath, "utf8")), {
      env: { ANTHROPIC_BASE_URL: "https://new.invalid" }, permissions: settings.permissions
    });
    assert.equal((await ensureCorptieClaudeRuntime(options)).connectionSettingsChanged, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
