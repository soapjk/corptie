import { chmod, lstat, mkdir, readFile, readlink, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ENVIRONMENT_PLACEHOLDER = "{{CORPTIE_ENVIRONMENT}}";
const AUTHORITATIVE_WORKSPACE_HEADING = "# Authoritative Work Session workspace";
const LEGACY_WORKSPACE_HEADING = "# Git worktree isolation";
const LEGACY_CODEX_CONTEXT = /# Corptie runtime context\n\n- You are running inside Corptie, an Agent client powered by the official Codex runtime\.\n- This is Corptie's (production|development) environment\.\n- The active Codex configuration and state directory \(`CODEX_HOME`\) is `[^`]+`\.\n- Treat that directory as authoritative for this session\. Do not assume or modify the native Codex home at `~\/\.codex` unless the user explicitly asks\./;

export function resolveCorptieAgentMemoryPaths(options = {}) {
  const home = resolve(options.homeDir ?? os.homedir());
  const corptieHome = resolve(options.corptieHome ?? process.env.CORPTIE_HOME ?? join(home, ".corptie"));
  const environmentName = options.environmentName === "development" ? "development" : "production";
  const runtimesRoot = environmentName === "development"
    ? join(corptieHome, "development", "runtimes")
    : join(corptieHome, "runtimes");
  return {
    corptieHome,
    environmentName,
    sharedMemoryPath: join(runtimesRoot, "shared", "AGENT_MEMORY.md")
  };
}

export async function ensureCorptieAgentMemory(options = {}) {
  const paths = resolveCorptieAgentMemoryPaths(options);
  const bundledMemoryPath = resolve(String(options.bundledMemoryPath ?? ""));
  if (!options.bundledMemoryPath || !await isFile(bundledMemoryPath)) {
    throw new Error(`Bundled Corptie Agent memory is missing: ${bundledMemoryPath}`);
  }

  const sourcePath = options.legacyMemoryPath ? resolve(options.legacyMemoryPath) : null;
  const bundled = renderBundledMemory(await readFile(bundledMemoryPath, "utf8"), paths.environmentName);
  let created = false;
  let migratedLegacyMemory = false;
  let updatedManagedWorkspaceRules = false;
  if (!await isFile(paths.sharedMemoryPath)) {
    let content = bundled;
    if (sourcePath && await isFile(sourcePath)) {
      content = migrateLegacyCodexContext(await readFile(sourcePath, "utf8"), bundled);
      migratedLegacyMemory = true;
    }
    await atomicWrite(paths.sharedMemoryPath, content, 0o600);
    created = true;
  } else {
    const existing = await readFile(paths.sharedMemoryPath, "utf8");
    const reconciled = reconcileManagedWorkspaceRules(existing, bundled);
    if (reconciled !== existing) {
      await atomicWrite(paths.sharedMemoryPath, reconciled, 0o600);
      updatedManagedWorkspaceRules = true;
    } else {
      await chmod(paths.sharedMemoryPath, 0o600);
    }
  }

  return {
    ...paths,
    bundledMemoryPath,
    created,
    migratedLegacyMemory,
    updatedManagedWorkspaceRules,
    available: await isFile(paths.sharedMemoryPath)
  };
}

export async function ensureProviderMemoryLink(sharedMemoryPath, providerMemoryPath) {
  const source = resolve(sharedMemoryPath);
  const destination = resolve(providerMemoryPath);
  if (!await isFile(source)) {
    throw new Error(`Shared Corptie Agent memory is missing: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const target = relative(dirname(destination), source);
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() && await readlink(destination) === target) return false;
    const backup = `${destination}.pre-unified-memory`;
    if (!await pathExists(backup)) await rename(destination, backup);
    else await rename(destination, `${destination}.pre-unified-memory-${Date.now()}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(target, destination);
  return true;
}

function renderBundledMemory(template, environmentName) {
  if (!template.includes(ENVIRONMENT_PLACEHOLDER)) {
    throw new Error(`Bundled Corptie Agent memory is missing ${ENVIRONMENT_PLACEHOLDER}`);
  }
  return template.replaceAll(ENVIRONMENT_PLACEHOLDER, environmentName);
}

function migrateLegacyCodexContext(content, bundled) {
  if (!LEGACY_CODEX_CONTEXT.test(content)) return content;
  const neutralContext = bundled.split(/\n# (?:Authoritative Work Session workspace|Git worktree isolation)/, 1)[0].trimEnd();
  return content.replace(LEGACY_CODEX_CONTEXT, neutralContext);
}

function reconcileManagedWorkspaceRules(existing, bundled) {
  const replacement = topLevelSection(bundled, AUTHORITATIVE_WORKSPACE_HEADING);
  if (!replacement) {
    // Custom/test distributions predating the managed Workspace section keep
    // their existing memory verbatim. Official Corptie bundles are covered by
    // a contract test and always provide this section.
    return existing;
  }

  for (const heading of [AUTHORITATIVE_WORKSPACE_HEADING, LEGACY_WORKSPACE_HEADING]) {
    const range = topLevelSectionRange(existing, heading);
    if (!range) continue;
    return [
      existing.slice(0, range.start).trimEnd(),
      replacement,
      existing.slice(range.end).trim()
    ].filter(Boolean).join("\n\n").concat("\n");
  }

  const externalActions = topLevelSectionRange(existing, "# External actions: local-only by default");
  if (externalActions) {
    return [
      existing.slice(0, externalActions.start).trimEnd(),
      replacement,
      existing.slice(externalActions.start).trim()
    ].filter(Boolean).join("\n\n").concat("\n");
  }
  return `${existing.trimEnd()}\n\n${replacement}\n`;
}

function topLevelSection(content, heading) {
  const range = topLevelSectionRange(content, heading);
  return range ? content.slice(range.start, range.end).trim() : null;
}

function topLevelSectionRange(content, heading) {
  const marker = `${heading}\n`;
  const start = content.indexOf(marker);
  if (start < 0) return null;
  const nextHeading = content.indexOf("\n# ", start + marker.length);
  return {
    start,
    end: nextHeading < 0 ? content.length : nextHeading + 1
  };
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

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
