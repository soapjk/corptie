import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensureCorptieCodexRuntime,
  resolveCorptieRuntimePaths
} from "../src/runtime/corptieCodexRuntime.mjs";

async function withFixture(run) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-codex-runtime-test-"));
  const sourceAuthPath = join(directory, "native-codex", "auth.json");
  const bundledAgentsPath = join(directory, "bundle", "global-instructions.production.md");
  const bundledSkillPath = join(directory, "bundle", "SKILL.md");
  const bundledProjectToolsReferencePath = join(directory, "bundle", "project-tools-set.md");
  const collaborationMcpServerPath = join(directory, "bundle", "collaborationMcpServer.mjs");
  await mkdir(join(directory, "native-codex"), { recursive: true });
  await mkdir(join(directory, "bundle"), { recursive: true });
  await writeFile(sourceAuthPath, '{"OPENAI_API_KEY":"local-test-token"}\n');
  await writeFile(bundledAgentsPath, "# Corptie global instructions\n\nEnvironment: `{{CORPTIE_ENVIRONMENT}}`\n");
  await writeFile(bundledSkillPath, "---\nname: corptie-collaboration\ndescription: test\n---\n\n# Test\n");
  await writeFile(bundledProjectToolsReferencePath, "# Project tools protocol\n");
  await writeFile(collaborationMcpServerPath, "export {};\n");
  try {
    await run({ directory, sourceAuthPath, bundledAgentsPath, bundledSkillPath, bundledProjectToolsReferencePath, collaborationMcpServerPath });
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
  await withFixture(async ({ directory, sourceAuthPath, bundledAgentsPath, bundledSkillPath, bundledProjectToolsReferencePath, collaborationMcpServerPath }) => {
    const result = await ensureCorptieCodexRuntime({
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      bundledAgentsPath,
      bundledSkillPath,
      bundledProjectToolsReferencePath,
      collaborationMcpServerPath
    });

    assert.equal(result.authCopied, true);
    assert.equal(result.agentsCreated, true);
    assert.equal(result.skillChanged, true);
    assert.equal(result.authAvailable, true);
    assert.equal(result.agentsAvailable, true);
    assert.match(await readFile(result.configPath, "utf8"), /cli_auth_credentials_store = "file"/);
    assert.match(await readFile(result.configPath, "utf8"), /mcp_oauth_credentials_store = "file"/);
    assert.equal(await readFile(result.authPath, "utf8"), '{"OPENAI_API_KEY":"local-test-token"}\n');
    assert.match(await readFile(result.authBootstrapMarkerPath, "utf8"), /"source": "copied"/);
    const agents = await readFile(result.agentsPath, "utf8");
    assert.match(agents, /Environment: `production`/);
    assert.doesNotMatch(agents, /\{\{CORPTIE_ENVIRONMENT\}\}/);
    assert.equal((await lstat(result.agentsPath)).isSymbolicLink(), true);
    assert.equal(await realpath(result.agentsPath), await realpath(result.sharedMemoryPath));
    assert.equal(await readFile(result.collaborationSkillPath, "utf8"), await readFile(bundledSkillPath, "utf8"));
    assert.equal(
      await readFile(result.collaborationProjectToolsReferencePath, "utf8"),
      await readFile(bundledProjectToolsReferencePath, "utf8")
    );
    assert.equal((await stat(result.codexHome)).mode & 0o777, 0o700);
    assert.equal((await stat(result.authPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.agentsPath)).mode & 0o777, 0o600);
  });
});

test("startup self-heals managed files without replacing authentication or shared Agent memory", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledAgentsPath, bundledSkillPath, collaborationMcpServerPath }) => {
    const options = {
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      bundledAgentsPath,
      bundledSkillPath,
      collaborationMcpServerPath
    };
    const first = await ensureCorptieCodexRuntime(options);
    await writeFile(first.authPath, '{"token":"corptie-account"}\n');
    await writeFile(first.agentsPath, "# User customized instructions\n");
    await writeFile(first.configPath, 'model = "custom"\ncli_auth_credentials_store = "keyring"\n[features]\nplugins = true\n');
    await writeFile(first.collaborationSkillPath, "stale\n");

    const second = await ensureCorptieCodexRuntime(options);
    const config = await readFile(second.configPath, "utf8");
    assert.equal(second.authCopied, false);
    assert.equal(second.agentsCreated, false);
    assert.equal(second.skillChanged, true);
    assert.equal(await readFile(second.authPath, "utf8"), '{"token":"corptie-account"}\n');
    const memory = await readFile(second.agentsPath, "utf8");
    assert.ok(memory.startsWith("# User customized instructions\n"));
    assert.match(memory, /# Corptie managed Artifact and Markdown policy/);
    assert.match(config, /model = "custom"/);
    assert.match(config, /cli_auth_credentials_store = "file"/);
    assert.match(config, /mcp_oauth_credentials_store = "file"/);
    assert.ok(config.indexOf('mcp_oauth_credentials_store = "file"') < config.indexOf("[features]"));
    assert.equal(await readFile(second.collaborationSkillPath, "utf8"), await readFile(bundledSkillPath, "utf8"));
  });
});

test("Keychain-only login is imported once into both isolated runtime environments", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledAgentsPath, bundledSkillPath, collaborationMcpServerPath }) => {
    await rm(sourceAuthPath);
    const nativeConfigPath = join(dirname(sourceAuthPath), "config.toml");
    const nativeConfig = 'cli_auth_credentials_store = "keyring"\nmodel = "native-model"\n';
    await writeFile(nativeConfigPath, nativeConfig);
    for (const environmentName of ["production", "development"]) {
      let reads = 0;
      const options = {
        corptieHome: join(directory, ".corptie"), environmentName, sourceAuthPath,
        bundledAgentsPath, bundledSkillPath, collaborationMcpServerPath,
        authenticationPlatform: "darwin",
        readKeychainCredential: async ({ service, account }) => {
          reads++;
          assert.equal(service, "Codex Auth");
          assert.match(account, /^cli\|[a-f0-9]{16}$/);
          return JSON.stringify({ tokens: { access_token: "test-keychain-login" } });
        }
      };
      // Provision unrelated managed files first; concurrent initialization here
      // exercises authentication coordination rather than memory-file creation.
      await ensureCorptieCodexRuntime({ ...options, authenticationPlatform: "linux" });
      const results = await Promise.all([
        ensureCorptieCodexRuntime(options), ensureCorptieCodexRuntime(options)
      ]);
      assert.equal(reads, 1);
      assert.equal(results[0].authAvailable, true);
      assert.equal(JSON.parse(await readFile(results[0].authPath, "utf8")).tokens.access_token, "test-keychain-login");
      assert.equal((await stat(results[0].authPath)).mode & 0o777, 0o600);
      const marker = await readFile(results[0].authBootstrapMarkerPath, "utf8");
      assert.match(marker, /"source": "keychain"/);
      assert.ok(!marker.includes("test-keychain-login"));
      assert.ok(!(await readFile(results[0].configPath, "utf8")).includes("native-model"));
      await writeFile(results[0].authPath, '{"token":"corptie-account"}\n');
      assert.equal((await ensureCorptieCodexRuntime(options)).authCopied, false);
      assert.equal(await readFile(results[0].authPath, "utf8"), '{"token":"corptie-account"}\n');
      await rm(results[0].authPath);
      assert.equal((await ensureCorptieCodexRuntime(options)).authAvailable, false);
      assert.equal(reads, 1, "an explicit logout must not silently restore Keychain login");
    }
    assert.equal(await readFile(nativeConfigPath, "utf8"), nativeConfig);
    await assert.rejects(readFile(sourceAuthPath), /ENOENT/);
  });
});

test("Keychain denial leaves authentication bootstrap retryable without leaking diagnostics", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledAgentsPath, bundledSkillPath, collaborationMcpServerPath }) => {
    await rm(sourceAuthPath);
    const options = {
      corptieHome: join(directory, ".corptie"), sourceAuthPath,
      bundledAgentsPath, bundledSkillPath, collaborationMcpServerPath,
      authenticationPlatform: "darwin",
      readKeychainCredential: async () => { throw new Error("test-secret-from-keychain"); }
    };
    await assert.rejects(ensureCorptieCodexRuntime(options), error =>
      !error.message.includes("test-secret") && error.message.includes("钥匙串"));
    const paths = resolveCorptieRuntimePaths(options);
    await assert.rejects(readFile(paths.authBootstrapMarkerPath), /ENOENT/);
    options.readKeychainCredential = async () => '{"OPENAI_API_KEY":"test-key"}';
    const result = await ensureCorptieCodexRuntime(options);
    assert.equal(result.authAvailable, true);
    assert.equal(result.authCopied, true);
  });
});

test("startup rebases migrated Codex rollout paths only when the current runtime owns the file", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledAgentsPath, bundledSkillPath, collaborationMcpServerPath }) => {
    const corptieHome = join(directory, "new-root");
    const codexHome = join(corptieHome, "runtimes", "codex");
    const rolloutName = "sessions/2026/08/29/rollout-valid.jsonl";
    const currentRollout = join(codexHome, rolloutName);
    await mkdir(dirname(currentRollout), { recursive: true });
    await writeFile(currentRollout, "{}\n");
    await mkdir(codexHome, { recursive: true });
    const statePath = join(codexHome, "state_5.sqlite");
    const database = new DatabaseSync(statePath);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)");
    insert.run("valid", join(directory, "old-root", "runtimes", "codex", rolloutName));
    insert.run("missing", join(directory, "old-root", "runtimes", "codex", "sessions/missing.jsonl"));
    insert.run("unowned", join(directory, "somewhere-else", "sessions", "rollout.jsonl"));
    insert.run("current", currentRollout);
    database.close();

    const options = {
      corptieHome,
      sourceAuthPath,
      bundledAgentsPath,
      bundledSkillPath,
      collaborationMcpServerPath
    };
    const first = await ensureCorptieCodexRuntime(options);
    assert.equal(first.rolloutPathRepair.repairedCount, 1);
    assert.equal(first.rolloutPathRepair.backups.length, 1);
    const repaired = new DatabaseSync(statePath, { readOnly: true });
    assert.equal(repaired.prepare("SELECT rollout_path FROM threads WHERE id='valid'").get().rollout_path, currentRollout);
    assert.match(repaired.prepare("SELECT rollout_path FROM threads WHERE id='missing'").get().rollout_path, /old-root/);
    assert.match(repaired.prepare("SELECT rollout_path FROM threads WHERE id='unowned'").get().rollout_path, /somewhere-else/);
    repaired.close();
    assert.equal((await readdir(codexHome)).filter((name) => name.includes("pre-path-rebase")).length, 1);

    const second = await ensureCorptieCodexRuntime(options);
    assert.equal(second.rolloutPathRepair.repairedCount, 0);
    assert.deepEqual(second.rolloutPathRepair.backups, []);
  });
});

test("authentication bootstrap never restores native credentials after a Corptie logout", async () => {
  await withFixture(async ({ directory, sourceAuthPath, bundledAgentsPath, bundledSkillPath, collaborationMcpServerPath }) => {
    const options = {
      corptieHome: join(directory, ".corptie"),
      sourceAuthPath,
      bundledAgentsPath,
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

test("initialization fails closed when the built-in AGENTS.md is absent", async () => {
  await assert.rejects(
    ensureCorptieCodexRuntime({
      corptieHome: join(os.tmpdir(), "corptie-missing-runtime"),
      bundledAgentsPath: join(os.tmpdir(), "missing-agents"),
      bundledSkillPath: join(os.tmpdir(), "missing-skill"),
      collaborationMcpServerPath: join(os.tmpdir(), "missing-mcp")
    }),
    /Agent memory is missing/
  );
});
