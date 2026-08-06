import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitWorkspaceSnapshot, inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

export const PROJECT_TOOLSET_SCHEMA_VERSION = 1;
export const PROJECT_TOOLSET_ACTIONS = Object.freeze([
  "start",
  "restart",
  "stop",
  "status",
  "health",
  "version"
]);

export class ProjectToolsetManager {
  constructor(options = {}) {
    this.execFile = options.execFile ?? execFileAsync;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async inspect(workingDirectory) {
    const layout = await this.layout(workingDirectory);
    const manifest = await readJsonFile(layout.manifestPath);
    const scripts = {};
    for (const action of PROJECT_TOOLSET_ACTIONS) {
      scripts[action] = await fileState(join(layout.scriptsPath, action));
    }
    return {
      ...layout,
      installed: Boolean(manifest),
      configured: manifest?.configured === true,
      schemaVersion: manifest?.schemaVersion ?? null,
      manifest,
      scripts
    };
  }

  async scaffold(workingDirectory, options = {}) {
    const layout = await this.layout(workingDirectory);
    await this.assertToolsetDirectoryIsPrivate(layout.mainPath);
    await mkdir(layout.scriptsPath, { recursive: true, mode: 0o700 });
    await mkdir(layout.runtimePath, { recursive: true, mode: 0o700 });

    const previous = await readJsonFile(layout.manifestPath);
    const manifest = {
      schemaVersion: PROJECT_TOOLSET_SCHEMA_VERSION,
      name: "Corptie Scripts Tools Set",
      configured: options.reset === true ? false : previous?.configured === true,
      projectRoot: layout.mainPath,
      generatedAt: previous?.generatedAt ?? this.now(),
      updatedAt: this.now(),
      scripts: Object.fromEntries(PROJECT_TOOLSET_ACTIONS.map((action) => [
        action,
        `scripts/${action}`
      ]))
    };
    await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    for (const action of PROJECT_TOOLSET_ACTIONS) {
      const scriptPath = join(layout.scriptsPath, action);
      const existing = await fileState(scriptPath);
      if (existing.exists && options.reset !== true) continue;
      await writeFile(scriptPath, unconfiguredScript(action), { mode: 0o700 });
      await chmod(scriptPath, 0o700);
    }
    return this.inspect(layout.mainPath);
  }

  async markConfigured(workingDirectory) {
    const state = await this.inspect(workingDirectory);
    if (!state.installed) throw new Error("The Corptie Scripts Tools Set is not installed.");
    const missing = PROJECT_TOOLSET_ACTIONS.filter((action) => !state.scripts[action]?.executable);
    if (missing.length > 0) {
      throw new Error(`The Corptie toolset has missing or non-executable scripts: ${missing.join(", ")}`);
    }
    const manifest = {
      ...state.manifest,
      schemaVersion: PROJECT_TOOLSET_SCHEMA_VERSION,
      configured: true,
      updatedAt: this.now()
    };
    await writeFile(state.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return this.inspect(state.mainPath);
  }

  async run(workingDirectory, action, options = {}) {
    if (!PROJECT_TOOLSET_ACTIONS.includes(action)) {
      throw new Error(`Unsupported Corptie project toolset action: ${action}`);
    }
    const state = await this.inspect(workingDirectory);
    if (!state.installed || !state.configured) {
      throw new Error("The Corptie Scripts Tools Set is not configured for this project.");
    }
    const script = state.scripts[action];
    if (!script?.executable) {
      throw new Error(`The Corptie project script is not executable: ${action}`);
    }
    const requestedExecutionRoot = options.executionRoot ?? state.mainPath;
    const executionIdentity = await inspectGitWorkspace(requestedExecutionRoot);
    if (executionIdentity.repositoryId !== state.repositoryId) {
      throw new Error("The requested service worktree belongs to a different Git repository.");
    }
    const executionRoot = executionIdentity.canonicalPath;
    try {
      const result = await this.execFile(script.path, [], {
        cwd: executionRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        env: {
          ...process.env,
          CORPTIE_PROJECT_ROOT: executionRoot,
          CORPTIE_MAIN_PROJECT_ROOT: state.mainPath,
          CORPTIE_TOOLSET_ROOT: state.toolsetPath,
          CORPTIE_TOOLSET_SCHEMA_VERSION: String(PROJECT_TOOLSET_SCHEMA_VERSION)
        }
      });
      return parseActionOutput(action, result?.stdout, result?.stderr, 0);
    } catch (error) {
      if (error?.stdout || error?.stderr || Number.isInteger(error?.code)) {
        return parseActionOutput(action, error.stdout, error.stderr, Number(error.code) || 1);
      }
      throw error;
    }
  }

  async layout(workingDirectory) {
    const identity = await inspectGitWorkspace(workingDirectory);
    const snapshot = await createGitWorkspaceSnapshot(workingDirectory);
    const main = snapshot.worktrees.find((worktree) => worktree.isMain && worktree.availability === "available");
    if (!main) throw new Error("The repository's main worktree is unavailable.");
    const mainPath = main.canonicalPath || main.path;
    const toolsetPath = join(mainPath, ".corptie");
    return {
      repositoryId: identity.repositoryId,
      commonGitDirCanonicalPath: identity.commonGitDirCanonicalPath,
      mainWorktreeId: main.worktreeId,
      mainHeadOid: main.headOid,
      mainPath,
      toolsetPath,
      manifestPath: join(toolsetPath, "toolset.json"),
      scriptsPath: join(toolsetPath, "scripts"),
      runtimePath: join(toolsetPath, "runtime")
    };
  }

  async assertToolsetDirectoryIsPrivate(mainPath) {
    const result = await this.execFile(
      "git",
      ["-C", mainPath, "ls-files", "--", ".corptie"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 }
    );
    const tracked = String(result?.stdout ?? "").trim();
    if (tracked) {
      throw new Error(
        `The .corptie directory contains Git-tracked files and cannot safely hold private project tools: ${tracked}`
      );
    }
  }
}

function unconfiguredScript(action) {
  const payload = JSON.stringify({
    schemaVersion: PROJECT_TOOLSET_SCHEMA_VERSION,
    action,
    ok: false,
    configured: false,
    error: "Corptie project toolset is not configured"
  });
  return `#!/bin/sh\nset -eu\nprintf '%s\\n' '${payload}'\nexit 78\n`;
}

function parseActionOutput(action, stdout, stderr, exitCode) {
  const text = String(stdout ?? "").trim();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {
    action,
    ok: exitCode === 0 && Boolean(payload) && payload.schemaVersion === PROJECT_TOOLSET_SCHEMA_VERSION,
    exitCode,
    payload,
    stdout: text,
    stderr: String(stderr ?? "").trim()
  };
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function fileState(path) {
  try {
    const value = await stat(path);
    return {
      path,
      exists: value.isFile(),
      executable: value.isFile() && (value.mode & 0o111) !== 0
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, exists: false, executable: false };
    throw error;
  }
}
