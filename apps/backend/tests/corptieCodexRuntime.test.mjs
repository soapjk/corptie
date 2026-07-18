import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureCorptieCodexRuntime,
  resolveCorptieRuntimePaths
} from "../src/runtime/corptieCodexRuntime.mjs";

async function withFixture(run) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-codex-runtime-test-"));
  const sourceAuthPath = join(directory, "native-codex", "auth.json");
  const bundledSkillPath = join(directory, "bundle", "SKILL.md");
  const collaborationMcpServerPath = join(directory, "bundle", "collaborationMcpServer.mjs");
  await mkdir(join(directory, "native-codex"), { recursive: true });
  await mkdir(join(directory, "bundle"), { recursive: true });
  await writeFile(sourceAuthPath, '{"token":"local-test-token"}\n');
  await writeFile(bundledSkillPath, "---\nname: corptie-collaboration\ndescription: test\n---\n\n# Test\n");
  await writeFile(collaborationMcpServerPath, "export {};\n");
  try {
    await run({ directory, sourceAuthPath, bundledSkillPath, collaborationMcpServerPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("resolves isolated production and development Codex homes", () => {
  const production = resolveCorptieRuntimePaths({ homeDir: "/Users/test", environmentName: "production" });
  const development = resolveCorptieRuntimePaths({ homeDir: "/Users/test", environmentName: "development" });
  assert.equal(production.codexHome, "/Users/test/.corptie/runtimes/codex");
  assert.equal(development.codexHome, "/Users/test/.corptie/development/runtimes/codex");
});

test("initialization copies authentication and installs required runtime files", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledSkillPath, collaborationMcpServerPath }) => {
    const result = await ensureCorptieCodexRuntime({
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      bundledSkillPath,
      collaborationMcpServerPath
    });

    assert.equal(result.authCopied, true);
    assert.equal(result.skillChanged, true);
    assert.equal(result.authAvailable, true);
    assert.match(await readFile(result.configPath, "utf8"), /cli_auth_credentials_store = "file"/);
    assert.match(await readFile(result.configPath, "utf8"), /mcp_oauth_credentials_store = "file"/);
    assert.equal(await readFile(result.authPath, "utf8"), '{"token":"local-test-token"}\n');
    assert.match(await readFile(result.authBootstrapMarkerPath, "utf8"), /"source": "copied"/);
    assert.equal(await readFile(result.collaborationSkillPath, "utf8"), await readFile(bundledSkillPath, "utf8"));
    assert.equal((await stat(result.codexHome)).mode & 0o777, 0o700);
    assert.equal((await stat(result.authPath)).mode & 0o777, 0o600);
  });
});

test("startup self-heals config and Skill without replacing isolated authentication", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledSkillPath, collaborationMcpServerPath }) => {
    const options = {
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      bundledSkillPath,
      collaborationMcpServerPath
    };
    const first = await ensureCorptieCodexRuntime(options);
    await writeFile(first.authPath, '{"token":"corptie-account"}\n');
    await writeFile(first.configPath, 'model = "custom"\ncli_auth_credentials_store = "keyring"\n[features]\nplugins = true\n');
    await writeFile(first.collaborationSkillPath, "stale\n");

    const second = await ensureCorptieCodexRuntime(options);
    const config = await readFile(second.configPath, "utf8");
    assert.equal(second.authCopied, false);
    assert.equal(second.skillChanged, true);
    assert.equal(await readFile(second.authPath, "utf8"), '{"token":"corptie-account"}\n');
    assert.match(config, /model = "custom"/);
    assert.match(config, /cli_auth_credentials_store = "file"/);
    assert.match(config, /mcp_oauth_credentials_store = "file"/);
    assert.ok(config.indexOf('mcp_oauth_credentials_store = "file"') < config.indexOf("[features]"));
    assert.equal(await readFile(second.collaborationSkillPath, "utf8"), await readFile(bundledSkillPath, "utf8"));
  });
});

test("authentication bootstrap never restores native credentials after a Corptie logout", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledSkillPath, collaborationMcpServerPath }) => {
    const options = {
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      bundledSkillPath,
      collaborationMcpServerPath
    };
    const first = await ensureCorptieCodexRuntime(options);
    assert.equal(first.authCopied, true);
    await rm(first.authPath);

    const second = await ensureCorptieCodexRuntime(options);
    assert.equal(second.authCopied, false);
    assert.equal(second.authAvailable, false);
    await assert.rejects(readFile(second.authPath), /ENOENT/);
  });
});

test("first startup migrates only Corptie-owned legacy rollouts and support files", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledSkillPath, collaborationMcpServerPath }) => {
    const legacyCodexHome = join(directory, "legacy-codex");
    const wantedThread = "019f-wanted-thread";
    const unrelatedThread = "019f-unrelated-thread";
    await mkdir(join(legacyCodexHome, "sessions", "2026", "07", "18"), { recursive: true });
    await mkdir(join(legacyCodexHome, "shell_snapshots"), { recursive: true });
    await writeFile(join(legacyCodexHome, "sessions", "2026", "07", "18", `rollout-${wantedThread}.jsonl`), "wanted\n");
    await writeFile(join(legacyCodexHome, "sessions", "2026", "07", "18", `rollout-${unrelatedThread}.jsonl`), "unrelated\n");
    await writeFile(join(legacyCodexHome, "shell_snapshots", `${wantedThread}.sh`), "snapshot\n");

    const result = await ensureCorptieCodexRuntime({
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      legacyCodexHome,
      legacyThreadIds: [`codex:${wantedThread}`],
      bundledSkillPath,
      collaborationMcpServerPath
    });

    assert.deepEqual(result.threadMigration, { performed: true, rolloutCount: 1, supportFileCount: 1 });
    assert.equal(
      await readFile(join(result.codexHome, "sessions", "2026", "07", "18", `rollout-${wantedThread}.jsonl`), "utf8"),
      "wanted\n"
    );
    await assert.rejects(
      readFile(join(result.codexHome, "sessions", "2026", "07", "18", `rollout-${unrelatedThread}.jsonl`), "utf8"),
      /ENOENT/
    );

    const second = await ensureCorptieCodexRuntime({
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      legacyCodexHome,
      legacyThreadIds: [`codex:${wantedThread}`],
      bundledSkillPath,
      collaborationMcpServerPath
    });
    assert.deepEqual(second.threadMigration, { performed: false, rolloutCount: 0, supportFileCount: 0 });
  });
});

test("initialization fails closed when a required built-in component is absent", async () => {
  await assert.rejects(
    ensureCorptieCodexRuntime({
      corptieHome: join(os.tmpdir(), "corptie-missing-runtime"),
      bundledSkillPath: join(os.tmpdir(), "missing-skill"),
      collaborationMcpServerPath: join(os.tmpdir(), "missing-mcp")
    }),
    /Skill is missing/
  );
});
