import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  ensureCorptieAgentMemory,
  ensureProviderMemoryLink,
  resolveCorptieAgentMemoryPaths
} from "./corptieAgentMemory.mjs";

const MANAGED_CONFIG_HEADER = "# Managed by Corptie. Runtime-specific user settings may be added below.";
const REQUIRED_CONFIG = Object.freeze({
  cli_auth_credentials_store: "file",
  mcp_oauth_credentials_store: "file"
});

export function resolveCorptieRuntimePaths(options = {}) {
  const home = resolve(options.homeDir ?? os.homedir());
  const corptieHome = resolve(options.corptieHome ?? process.env.CORPTIE_HOME ?? join(home, ".corptie"));
  const environmentName = options.environmentName === "development" ? "development" : "production";
  const runtimeRoot = environmentName === "development"
    ? join(corptieHome, "development", "runtimes", "codex")
    : join(corptieHome, "runtimes", "codex");
  const codexHome = resolve(options.codexHome ?? process.env.CORPTIE_CODEX_HOME ?? runtimeRoot);
  const agentMemory = resolveCorptieAgentMemoryPaths({ homeDir: home, corptieHome, environmentName });

  return {
    corptieHome,
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    agentsPath: join(codexHome, "AGENTS.md"),
    sharedMemoryPath: agentMemory.sharedMemoryPath,
    skillsDir: join(codexHome, "skills"),
    collaborationSkillDir: join(codexHome, "skills", "corptie-collaboration"),
    collaborationSkillPath: join(codexHome, "skills", "corptie-collaboration", "SKILL.md"),
    collaborationProjectToolsReferencePath: join(
      codexHome,
      "skills",
      "corptie-collaboration",
      "references",
      "project-tools-set.md"
    ),
    sourceAuthPath: resolve(options.sourceAuthPath ?? join(home, ".codex", "auth.json")),
    authBootstrapMarkerPath: join(codexHome, ".corptie-auth-bootstrap-v1.json")
  };
}

export async function ensureCorptieCodexRuntime(options = {}) {
  const paths = resolveCorptieRuntimePaths(options);
  const bundledSkillPath = resolve(String(options.bundledSkillPath ?? ""));
  const bundledMemoryPath = resolve(String(options.bundledMemoryPath ?? options.bundledAgentsPath ?? ""));
  const collaborationMcpServerPath = resolve(String(options.collaborationMcpServerPath ?? ""));
  const bundledProjectToolsReferencePath = options.bundledProjectToolsReferencePath
    ? resolve(String(options.bundledProjectToolsReferencePath))
    : null;

  if (!(options.bundledMemoryPath || options.bundledAgentsPath) || !await isFile(bundledMemoryPath)) {
    throw new Error(`Bundled Corptie Agent memory is missing: ${bundledMemoryPath}`);
  }
  if (!options.bundledSkillPath || !await isFile(bundledSkillPath)) {
    throw new Error(`Bundled Corptie collaboration Skill is missing: ${bundledSkillPath}`);
  }
  if (!options.collaborationMcpServerPath || !await isFile(collaborationMcpServerPath)) {
    throw new Error(`Bundled Corptie collaboration MCP server is missing: ${collaborationMcpServerPath}`);
  }
  if (bundledProjectToolsReferencePath && !await isFile(bundledProjectToolsReferencePath)) {
    throw new Error(`Bundled Corptie project-tools reference is missing: ${bundledProjectToolsReferencePath}`);
  }

  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await chmod(paths.codexHome, 0o700);
  const rolloutPathRepair = await repairMigratedRolloutPaths(paths.codexHome);
  await mkdir(paths.collaborationSkillDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.collaborationProjectToolsReferencePath), { recursive: true, mode: 0o700 });

  const configChanged = await ensureRuntimeConfig(paths.configPath);
  const authCopied = await bootstrapAuthentication(paths);
  const agentMemory = await ensureCorptieAgentMemory({
    ...options,
    bundledMemoryPath,
    legacyMemoryPath: paths.agentsPath
  });
  const memoryLinkChanged = await ensureProviderMemoryLink(agentMemory.sharedMemoryPath, paths.agentsPath);
  const skillChanged = await syncManagedFile(bundledSkillPath, paths.collaborationSkillPath, 0o600);
  const projectToolsReferenceChanged = bundledProjectToolsReferencePath
    ? await syncManagedFile(
        bundledProjectToolsReferencePath,
        paths.collaborationProjectToolsReferencePath,
        0o600
      )
    : false;
  return {
    ...paths,
    bundledMemoryPath,
    bundledSkillPath,
    collaborationMcpServerPath,
    configChanged,
    authCopied,
    agentsCreated: agentMemory.created,
    memoryLinkChanged,
    agentMemory,
    skillChanged,
    projectToolsReferenceChanged,
    rolloutPathRepair,
    authAvailable: await isFile(paths.authPath),
    agentsAvailable: await isFile(paths.agentsPath),
    skillAvailable: await isFile(paths.collaborationSkillPath),
    mcpAvailable: true
  };
}

export async function repairMigratedRolloutPaths(codexHome) {
  const runtimeRoot = resolve(codexHome);
  const stateDatabases = (await readdir(runtimeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^state(?:_\d+)?\.sqlite$/.test(entry.name))
    .map((entry) => join(runtimeRoot, entry.name));
  let repairedCount = 0;
  const backups = [];

  for (const databasePath of stateDatabases) {
    const database = new DatabaseSync(databasePath);
    try {
      if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
        throw new Error(`Codex state database failed integrity verification: ${databasePath}`);
      }
      const hasThreads = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'"
      ).get();
      if (!hasThreads) continue;
      const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
      if (!columns.has("id") || !columns.has("rollout_path")) continue;

      const candidates = [];
      for (const row of database.prepare("SELECT id, rollout_path FROM threads").all()) {
        const targetPath = migratedRolloutPath(row.rollout_path, runtimeRoot);
        if (targetPath && await isFile(targetPath)) {
          candidates.push({ id: row.id, sourcePath: row.rollout_path, targetPath });
        }
      }
      if (candidates.length === 0) continue;

      const backupPath = `${databasePath}.corptie-pre-path-rebase-${Date.now()}.bak`;
      await backup(database, backupPath);
      const update = database.prepare(
        "UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?"
      );
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const candidate of candidates) {
          const result = update.run(candidate.targetPath, candidate.id, candidate.sourcePath);
          repairedCount += Number(result.changes ?? 0);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      backups.push(backupPath);
    } finally {
      database.close();
    }
  }

  return { repairedCount, backups };
}

function migratedRolloutPath(value, codexHome) {
  if (typeof value !== "string" || !value.trim()) return null;
  const currentPath = resolve(value);
  if (isDescendant(codexHome, currentPath)) return null;
  const normalized = currentPath.split(sep).join("/");
  const marker = "/runtimes/codex/sessions/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const suffix = normalized.slice(markerIndex + "/runtimes/codex/".length);
  const targetPath = resolve(codexHome, suffix);
  return isDescendant(codexHome, targetPath) ? targetPath : null;
}

function isDescendant(root, path) {
  const child = relative(resolve(root), resolve(path));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function ensureRuntimeConfig(path) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let next = current.trimEnd();
  if (!next) next = MANAGED_CONFIG_HEADER;
  for (const [key, value] of Object.entries(REQUIRED_CONFIG)) {
    const assignment = `${key} = ${JSON.stringify(value)}`;
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "m");
    next = pattern.test(next) ? next.replace(pattern, assignment) : insertTopLevelSetting(next, assignment);
  }
  next = `${next}\n`;

  if (next === current) {
    await chmod(path, 0o600);
    return false;
  }
  await atomicWrite(path, next, 0o600);
  return true;
}

function insertTopLevelSetting(config, assignment) {
  const lines = config.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable < 0) return `${config}\n${assignment}`;
  lines.splice(firstTable, 0, assignment);
  return lines.join("\n");
}

async function bootstrapAuthentication(paths) {
  if (await isFile(paths.authBootstrapMarkerPath)) {
    if (await isFile(paths.authPath)) await chmod(paths.authPath, 0o600);
    return false;
  }
  if (await isFile(paths.authPath)) {
    await chmod(paths.authPath, 0o600);
    await writeAuthBootstrapMarker(paths, "existing");
    return false;
  }
  if (!await isFile(paths.sourceAuthPath)) return false;

  await mkdir(dirname(paths.authPath), { recursive: true, mode: 0o700 });
  try {
    await copyFile(paths.sourceAuthPath, paths.authPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await chmod(paths.authPath, 0o600);
  await writeAuthBootstrapMarker(paths, "copied");
  return true;
}

async function writeAuthBootstrapMarker(paths, source) {
  await atomicWrite(paths.authBootstrapMarkerPath, `${JSON.stringify({
    version: 1,
    completedAt: new Date().toISOString(),
    source
  }, null, 2)}\n`, 0o600);
}

async function syncManagedFile(source, destination, mode) {
  const expected = await readFile(source);
  let current = null;
  try {
    current = await readFile(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current?.equals(expected)) {
    await chmod(destination, mode);
    return false;
  }
  await atomicWrite(destination, expected, mode);
  return true;
}

async function atomicWrite(path, content, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, content, { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, path);
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
