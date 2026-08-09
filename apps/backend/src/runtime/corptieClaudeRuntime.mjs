import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const PLUGIN_MANIFEST = Object.freeze({
  name: "corptie-runtime",
  version: "0.5.2",
  description: "Corptie-owned skills for Claude Code sessions."
});

export function resolveCorptieClaudeRuntimePaths(options = {}) {
  const home = resolve(options.homeDir ?? os.homedir());
  const corptieHome = resolve(options.corptieHome ?? process.env.CORPTIE_HOME ?? join(home, ".corptie"));
  const environmentName = options.environmentName === "development" ? "development" : "production";
  const runtimeRoot = environmentName === "development"
    ? join(corptieHome, "development", "runtimes", "claude")
    : join(corptieHome, "runtimes", "claude");
  const pluginPath = join(runtimeRoot, "corptie-plugin");
  const skillPath = join(pluginPath, "skills", "corptie-collaboration", "SKILL.md");
  return {
    corptieHome,
    runtimeRoot,
    pluginPath,
    manifestPath: join(pluginPath, ".claude-plugin", "plugin.json"),
    skillPath,
    projectToolsReferencePath: join(dirname(skillPath), "references", "project-tools-set.md")
  };
}

export async function ensureCorptieClaudeRuntime(options = {}) {
  const paths = resolveCorptieClaudeRuntimePaths(options);
  const bundledSkillPath = resolve(String(options.bundledSkillPath ?? ""));
  const bundledProjectToolsReferencePath = resolve(String(options.bundledProjectToolsReferencePath ?? ""));
  if (!options.bundledSkillPath || !await isFile(bundledSkillPath)) {
    throw new Error(`Bundled Corptie collaboration Skill is missing: ${bundledSkillPath}`);
  }
  if (!options.bundledProjectToolsReferencePath || !await isFile(bundledProjectToolsReferencePath)) {
    throw new Error(`Bundled Corptie project-tools reference is missing: ${bundledProjectToolsReferencePath}`);
  }

  await mkdir(paths.pluginPath, { recursive: true, mode: 0o700 });
  await chmod(paths.pluginPath, 0o700);
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
    manifestChanged,
    skillChanged,
    projectToolsReferenceChanged,
    pluginAvailable: await isFile(paths.manifestPath),
    skillAvailable: await isFile(paths.skillPath)
  };
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
