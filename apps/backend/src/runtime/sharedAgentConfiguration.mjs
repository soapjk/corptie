import { execFile } from "node:child_process";
import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_SHARED_AGENT_CONFIGURATION_PATHS = Object.freeze([
  ".corptie",
  ".agents",
  ".agent",
  ".codex",
  ".claude",
  ".cursor",
  ".gemini",
  ".mcp.json",
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md"
]);

export async function linkSharedAgentConfiguration(options) {
  const run = options.execFile ?? execFileAsync;
  const mainPath = options.mainPath;
  const targetPath = options.targetPath;
  const paths = options.paths ?? DEFAULT_SHARED_AGENT_CONFIGURATION_PATHS;
  const result = {
    linked: [],
    alreadyLinked: [],
    skippedTracked: [],
    skippedMissing: [],
    conflicts: []
  };

  for (const relativePath of paths) {
    const source = join(mainPath, relativePath);
    const target = join(targetPath, relativePath);
    if (!await pathExists(source)) {
      result.skippedMissing.push(relativePath);
      continue;
    }
    if (await isTracked(run, mainPath, relativePath)) {
      result.skippedTracked.push(relativePath);
      continue;
    }
    if (await pathExists(target)) {
      const existingTarget = await symlinkTarget(target);
      if (existingTarget === source) {
        result.alreadyLinked.push(relativePath);
      } else {
        result.conflicts.push(relativePath);
      }
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target);
    result.linked.push(relativePath);
  }
  return result;
}

async function isTracked(run, mainPath, relativePath) {
  const result = await run(
    "git",
    ["-C", mainPath, "ls-files", "--error-unmatch", "--", relativePath],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  ).catch(() => null);
  return Boolean(result);
}

async function symlinkTarget(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isSymbolicLink() ? await readlink(path) : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
