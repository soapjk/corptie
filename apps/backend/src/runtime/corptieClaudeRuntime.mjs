import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ensureCorptieAgentMemory,
  ensureProviderMemoryLink,
  resolveCorptieAgentMemoryPaths
} from "./corptieAgentMemory.mjs";

const PLUGIN_MANIFEST = Object.freeze({
  name: "corptie-runtime",
  version: "0.5.3",
  description: "Corptie-owned skills for Claude Code sessions."
});

export function resolveCorptieClaudeRuntimePaths(options = {}) {
  const home = resolve(options.homeDir ?? os.homedir());
  const corptieHome = resolve(options.corptieHome ?? process.env.CORPTIE_HOME ?? join(home, ".corptie"));
  const environmentName = options.environmentName === "development" ? "development" : "production";
  const runtimeRoot = environmentName === "development"
    ? join(corptieHome, "development", "runtimes", "claude")
    : join(corptieHome, "runtimes", "claude");
  const agentMemory = resolveCorptieAgentMemoryPaths({ homeDir: home, corptieHome, environmentName });
  const pluginPath = join(runtimeRoot, "corptie-plugin");
  const skillPath = join(pluginPath, "skills", "corptie-collaboration", "SKILL.md");
  return {
    corptieHome,
    runtimeRoot,
    configDir: runtimeRoot,
    claudeMemoryPath: join(runtimeRoot, "CLAUDE.md"),
    sharedMemoryPath: agentMemory.sharedMemoryPath,
    credentialsPath: join(runtimeRoot, ".credentials.json"),
    sourceCredentialsPath: resolve(options.sourceCredentialsPath ?? join(home, ".claude", ".credentials.json")),
    credentialsBootstrapMarkerPath: join(runtimeRoot, ".corptie-credentials-bootstrap-v1.json"),
    legacyClaudeHome: resolve(options.legacyClaudeHome ?? join(home, ".claude")),
    migrationMarkerPath: join(runtimeRoot, ".corptie-session-migration-v1.json"),
    pluginPath,
    manifestPath: join(pluginPath, ".claude-plugin", "plugin.json"),
    skillPath,
    projectToolsReferencePath: join(dirname(skillPath), "references", "project-tools-set.md")
  };
}

export async function ensureCorptieClaudeRuntime(options = {}) {
  const paths = resolveCorptieClaudeRuntimePaths(options);
  const bundledMemoryPath = resolve(String(options.bundledMemoryPath ?? ""));
  const bundledSkillPath = resolve(String(options.bundledSkillPath ?? ""));
  const bundledProjectToolsReferencePath = resolve(String(options.bundledProjectToolsReferencePath ?? ""));
  if (!options.bundledMemoryPath || !await isFile(bundledMemoryPath)) {
    throw new Error(`Bundled Corptie Agent memory is missing: ${bundledMemoryPath}`);
  }
  if (!options.bundledSkillPath || !await isFile(bundledSkillPath)) {
    throw new Error(`Bundled Corptie collaboration Skill is missing: ${bundledSkillPath}`);
  }
  if (!options.bundledProjectToolsReferencePath || !await isFile(bundledProjectToolsReferencePath)) {
    throw new Error(`Bundled Corptie project-tools reference is missing: ${bundledProjectToolsReferencePath}`);
  }

  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await chmod(paths.configDir, 0o700);
  await mkdir(paths.pluginPath, { recursive: true, mode: 0o700 });
  await chmod(paths.pluginPath, 0o700);
  const agentMemory = await ensureCorptieAgentMemory({ ...options, bundledMemoryPath });
  const memoryLinkChanged = await ensureProviderMemoryLink(
    agentMemory.sharedMemoryPath,
    paths.claudeMemoryPath
  );
  const credentialsCopied = await bootstrapCredentials(paths);
  const sessionMigration = await migrateLegacySessions(paths, options.legacySessionIds ?? []);
  const manifestChanged = await syncManagedContent(
    `${JSON.stringify(PLUGIN_MANIFEST, null, 2)}\n`,
    paths.manifestPath,
    0o600
  );
  const skillChanged = await syncManagedFile(bundledSkillPath, paths.skillPath, 0o600);
  const projectToolsReferenceChanged = await syncManagedFile(
    bundledProjectToolsReferencePath,
    paths.projectToolsReferencePath,
    0o600
  );
  return {
    ...paths,
    agentMemory,
    memoryLinkChanged,
    credentialsCopied,
    sessionMigration,
    manifestChanged,
    skillChanged,
    projectToolsReferenceChanged,
    pluginAvailable: await isFile(paths.manifestPath),
    skillAvailable: await isFile(paths.skillPath),
    memoryAvailable: await isFile(paths.claudeMemoryPath),
    credentialsAvailable: await isFile(paths.credentialsPath)
  };
}

async function bootstrapCredentials(paths) {
  if (await isFile(paths.credentialsBootstrapMarkerPath)) {
    if (await isFile(paths.credentialsPath)) await chmod(paths.credentialsPath, 0o600);
    return false;
  }
  if (await isFile(paths.credentialsPath)) {
    await chmod(paths.credentialsPath, 0o600);
    await writeBootstrapMarker(paths, "existing");
    return false;
  }
  if (!await isFile(paths.sourceCredentialsPath)) return false;
  try {
    await copyFile(paths.sourceCredentialsPath, paths.credentialsPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await chmod(paths.credentialsPath, 0o600);
  await writeBootstrapMarker(paths, "copied");
  return true;
}

async function writeBootstrapMarker(paths, source) {
  await atomicWrite(paths.credentialsBootstrapMarkerPath, `${JSON.stringify({
    version: 1,
    completedAt: new Date().toISOString(),
    source
  }, null, 2)}\n`, 0o600);
}

async function migrateLegacySessions(paths, legacySessionIds) {
  if (await isFile(paths.migrationMarkerPath)) {
    return { performed: false, fileCount: 0 };
  }
  const sessionIds = new Set(legacySessionIds.map((value) => String(value ?? "").trim()).filter(Boolean));
  let fileCount = 0;
  const sourceRoot = join(paths.legacyClaudeHome, "projects");
  const destinationRoot = join(paths.configDir, "projects");
  if (sessionIds.size > 0 && paths.legacyClaudeHome !== paths.configDir && await isDirectory(sourceRoot)) {
    for (const entry of await readdir(sourceRoot, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const parentPath = entry.parentPath ?? entry.path ?? sourceRoot;
      const source = join(parentPath, entry.name);
      const relativePath = source.slice(sourceRoot.length + 1);
      const segments = relativePath.split(/[\\/]/);
      const matches = [...sessionIds].some((sessionId) => (
        entry.name === `${sessionId}.jsonl` || segments.includes(sessionId)
      ));
      if (!matches) continue;
      const destination = join(destinationRoot, relativePath);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      fileCount += 1;
    }
  }
  await atomicWrite(paths.migrationMarkerPath, `${JSON.stringify({
    version: 1,
    migratedAt: new Date().toISOString(),
    requestedSessionCount: sessionIds.size,
    fileCount
  }, null, 2)}\n`, 0o600);
  return { performed: true, fileCount };
}

async function syncManagedFile(source, destination, mode) {
  return syncManagedContent(await readFile(source), destination, mode);
}

async function syncManagedContent(content, destination, mode) {
  let current = null;
  try {
    current = await readFile(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
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
