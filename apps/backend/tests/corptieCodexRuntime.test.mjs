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
  await writeFile(sourceAuthPath, '{"token":"local-test-token"}\n');
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
    assert.equal(await readFile(result.authPath, "utf8"), '{"token":"local-test-token"}\n');
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
    assert.equal(await readFile(second.agentsPath, "utf8"), "# User customized instructions\n");
    assert.match(config, /model = "custom"/);
    assert.match(config, /cli_auth_credentials_store = "file"/);
    assert.match(config, /mcp_oauth_credentials_store = "file"/);
    assert.ok(config.indexOf('mcp_oauth_credentials_store = "file"') < config.indexOf("[features]"));
    assert.equal(await readFile(second.collaborationSkillPath, "utf8"), await readFile(bundledSkillPath, "utf8"));
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
