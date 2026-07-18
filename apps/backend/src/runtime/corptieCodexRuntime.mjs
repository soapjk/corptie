import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

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

  return {
    corptieHome,
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    skillsDir: join(codexHome, "skills"),
    collaborationSkillDir: join(codexHome, "skills", "corptie-collaboration"),
    collaborationSkillPath: join(codexHome, "skills", "corptie-collaboration", "SKILL.md"),
    sourceAuthPath: resolve(options.sourceAuthPath ?? join(home, ".codex", "auth.json")),
    legacyCodexHome: resolve(options.legacyCodexHome ?? join(home, ".codex")),
    authBootstrapMarkerPath: join(codexHome, ".corptie-auth-bootstrap-v1.json"),
    migrationMarkerPath: join(codexHome, ".corptie-migration-v1.json")
  };
}

export async function ensureCorptieCodexRuntime(options = {}) {
  const paths = resolveCorptieRuntimePaths(options);
  const bundledSkillPath = resolve(String(options.bundledSkillPath ?? ""));
  const collaborationMcpServerPath = resolve(String(options.collaborationMcpServerPath ?? ""));

  if (!options.bundledSkillPath || !await isFile(bundledSkillPath)) {
    throw new Error(`Bundled Corptie collaboration Skill is missing: ${bundledSkillPath}`);
  }
  if (!options.collaborationMcpServerPath || !await isFile(collaborationMcpServerPath)) {
    throw new Error(`Bundled Corptie collaboration MCP server is missing: ${collaborationMcpServerPath}`);
  }

  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await chmod(paths.codexHome, 0o700);
  await mkdir(paths.collaborationSkillDir, { recursive: true, mode: 0o700 });

  const configChanged = await ensureRuntimeConfig(paths.configPath);
  const authCopied = await bootstrapAuthentication(paths);
  const skillChanged = await syncManagedFile(bundledSkillPath, paths.collaborationSkillPath, 0o600);
  const threadMigration = await migrateLegacyThreads(paths, options.legacyThreadIds ?? []);

  return {
    ...paths,
    bundledSkillPath,
    collaborationMcpServerPath,
    configChanged,
    authCopied,
    skillChanged,
    threadMigration,
    authAvailable: await isFile(paths.authPath),
    skillAvailable: await isFile(paths.collaborationSkillPath),
    mcpAvailable: true
  };
}

async function migrateLegacyThreads(paths, legacyThreadIds) {
  if (await isFile(paths.migrationMarkerPath)) {
    return { performed: false, rolloutCount: 0, supportFileCount: 0 };
  }

  const threadIds = new Set(legacyThreadIds
    .map((value) => String(value ?? "").replace(/^codex:/, "").trim())
    .filter(Boolean));
  let rolloutCount = 0;
  let supportFileCount = 0;

  if (threadIds.size > 0 && paths.legacyCodexHome !== paths.codexHome) {
    for (const directory of ["sessions", "archived_sessions"]) {
      rolloutCount += await copyMatchingFiles(
        join(paths.legacyCodexHome, directory),
        join(paths.codexHome, directory),
        (name) => name.endsWith(".jsonl") && includesThreadId(name, threadIds)
      );
    }
    supportFileCount += await copyMatchingFiles(
      join(paths.legacyCodexHome, "shell_snapshots"),
      join(paths.codexHome, "shell_snapshots"),
      (name) => includesThreadId(name, threadIds)
    );
  }

  const marker = {
    version: 1,
    migratedAt: new Date().toISOString(),
    requestedThreadCount: threadIds.size,
    rolloutCount,
    supportFileCount
  };
  await atomicWrite(paths.migrationMarkerPath, `${JSON.stringify(marker, null, 2)}\n`, 0o600);
  return { performed: true, rolloutCount, supportFileCount };
}

async function copyMatchingFiles(sourceRoot, destinationRoot, matches) {
  if (!await isDirectory(sourceRoot)) return 0;
  let count = 0;
  for (const entry of await readdir(sourceRoot, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !matches(entry.name)) continue;
    const parentPath = entry.parentPath ?? entry.path ?? sourceRoot;
    const source = join(parentPath, entry.name);
    const relative = source.slice(sourceRoot.length + 1);
    const destination = join(destinationRoot, relative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, 0o600);
    count += 1;
  }
  return count;
}

function includesThreadId(name, threadIds) {
  for (const threadId of threadIds) {
    if (name.includes(threadId)) return true;
  }
  return false;
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
