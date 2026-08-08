import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitWorkspaceSnapshot, inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

export const PROJECT_TOOLSET_SCHEMA_VERSION = 2;
export const PROJECT_TOOLSET_ACTIONS = Object.freeze([
  "build",
  "start",
  "restart",
  "stop",
  "status",
  "health",
  "verify",
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
      manifestConfigured: manifest?.configured === true,
      compatible: manifest?.schemaVersion === PROJECT_TOOLSET_SCHEMA_VERSION,
      requiresUpdate: Boolean(manifest) && manifest?.schemaVersion !== PROJECT_TOOLSET_SCHEMA_VERSION,
      configured: manifest?.configured === true
        && manifest?.schemaVersion === PROJECT_TOOLSET_SCHEMA_VERSION,
      schemaVersion: manifest?.schemaVersion ?? null,
      profiles: normalizedProfiles(manifest),
      selectedProfile: selectedProfile(manifest),
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
    const profiles = normalizedProfiles(previous);
    const manifest = {
      schemaVersion: PROJECT_TOOLSET_SCHEMA_VERSION,
      name: "Corptie Scripts Tools Set",
      configured: options.unconfigure === true
        ? false
        : previous?.configured === true && previous?.schemaVersion === PROJECT_TOOLSET_SCHEMA_VERSION,
      projectRoot: layout.mainPath,
      generatedAt: previous?.generatedAt ?? this.now(),
      updatedAt: this.now(),
      profiles,
      selectedProfile: selectedProfile({ ...previous, profiles }),
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

  async selectProfile(workingDirectory, profileId) {
    const state = await this.inspect(workingDirectory);
    if (!state.installed) throw new Error("The Corptie Scripts Tools Set is not installed.");
    if (!state.compatible) throw new Error("Update the Corptie Scripts Tools Set before selecting a service profile.");
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`Unknown Corptie service profile: ${profileId}`);
    const manifest = {
      ...state.manifest,
      selectedProfile: profile.id,
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
    const canRunLegacyProbe = options.allowIncompatible === true
      && state.manifestConfigured
      && ["status", "health", "version"].includes(action);
    if (!state.installed || (!state.configured && !canRunLegacyProbe)) {
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
    const source = options.sourceIdentity ?? await this.sourceIdentity(executionRoot, state.runtimePath);
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
          CORPTIE_TOOLSET_SCHEMA_VERSION: String(PROJECT_TOOLSET_SCHEMA_VERSION),
          CORPTIE_SERVICE_PROFILE: state.selectedProfile,
          CORPTIE_SOURCE_REVISION: source.revision,
          CORPTIE_SOURCE_FINGERPRINT: source.fingerprint,
          CORPTIE_SOURCE_DIRTY: String(source.dirty)
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

  async activateLatest(workingDirectory, options = {}) {
    const state = await this.inspect(workingDirectory);
    if (!state.configured) {
      throw new Error(state.requiresUpdate
        ? "Update the Corptie Scripts Tools Set before rebuilding and restarting this service."
        : "The Corptie Scripts Tools Set is not configured for this project.");
    }
    const executionRoot = options.executionRoot ?? state.mainPath;
    const source = await this.sourceIdentity(executionRoot, state.runtimePath);
    const build = await this.run(workingDirectory, "build", {
      executionRoot,
      sourceIdentity: source,
      timeoutMs: options.buildTimeoutMs ?? 10 * 60_000
    });
    if (!build.ok) return { ok: false, stage: "build", source, build };
    const restart = await this.run(workingDirectory, "restart", {
      executionRoot,
      sourceIdentity: source,
      timeoutMs: options.restartTimeoutMs ?? 60_000
    });
    if (!restart.ok) return { ok: false, stage: "restart", source, build, restart };
    const [status, health, verify, version] = await Promise.all([
      this.run(workingDirectory, "status", { executionRoot, sourceIdentity: source, timeoutMs: 5_000 }),
      this.run(workingDirectory, "health", { executionRoot, sourceIdentity: source, timeoutMs: 15_000 }),
      this.run(workingDirectory, "verify", { executionRoot, sourceIdentity: source, timeoutMs: 15_000 }),
      this.run(workingDirectory, "version", { executionRoot, sourceIdentity: source, timeoutMs: 5_000 })
    ]);
    const validation = validateActivation({
      source,
      profile: state.selectedProfile,
      build,
      status,
      health,
      verify,
      version
    });
    return {
      ok: validation.ok,
      stage: validation.ok ? "complete" : "verify",
      error: validation.error,
      source,
      profile: state.selectedProfile,
      build,
      restart,
      status,
      health,
      verify,
      version
    };
  }

  async sourceIdentity(workingDirectory, runtimePath = null) {
    const identity = await inspectGitWorkspace(workingDirectory);
    const revision = (await this.execFile(
      "git",
      ["-C", identity.canonicalPath, "rev-parse", "HEAD"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 }
    )).stdout.trim();
    const status = (await this.execFile(
      "git",
      [
        "-C", identity.canonicalPath,
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--", ".", ":(exclude).corptie"
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    )).stdout;
    if (!status) {
      const fingerprint = (await this.execFile(
        "git",
        ["-C", identity.canonicalPath, "rev-parse", "HEAD^{tree}"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 }
      )).stdout.trim();
      return {
        revision,
        fingerprint,
        dirty: false,
        worktreePath: identity.canonicalPath
      };
    }
    const temporaryIndex = join(runtimePath ?? identity.commonGitDirCanonicalPath, `.source-index-${randomUUID()}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      await this.execFile("git", ["-C", identity.canonicalPath, "read-tree", "HEAD"], { env });
      await this.execFile(
        "git",
        ["-C", identity.canonicalPath, "add", "-A", "--", ".", ":(exclude).corptie"],
        { env, maxBuffer: 8 * 1024 * 1024 }
      );
      const fingerprint = (await this.execFile(
        "git",
        ["-C", identity.canonicalPath, "write-tree"],
        { env, encoding: "utf8", maxBuffer: 1024 * 1024 }
      )).stdout.trim();
      return {
        revision,
        fingerprint,
        dirty: Boolean(status),
        worktreePath: identity.canonicalPath
      };
    } finally {
      await rm(temporaryIndex, { force: true });
    }
  }

  async revisionDetails(workingDirectory, revision, worktreePath) {
    if (!/^[0-9a-f]{40}$/i.test(String(revision ?? ""))) return null;
    const layout = await this.layout(workingDirectory);
    let sourcePath = layout.mainPath;
    let branch = null;
    if (worktreePath) {
      try {
        const identity = await inspectGitWorkspace(worktreePath);
        if (identity.repositoryId === layout.repositoryId) {
          sourcePath = identity.canonicalPath;
        }
      } catch {
        // A deleted source Worktree still has a verifiable commit in the main repository.
      }
    }
    const commit = await this.execFile(
      "git",
      ["-C", layout.mainPath, "show", "-s", "--format=%cI", revision],
      { encoding: "utf8", maxBuffer: 1024 * 1024 }
    );
    try {
      const result = await this.execFile(
        "git",
        ["-C", sourcePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 }
      );
      branch = String(result?.stdout ?? "").trim() || null;
    } catch {
      branch = null;
    }
    return {
      commitTime: String(commit?.stdout ?? "").trim() || null,
      branch
    };
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
    ok: exitCode === 0
      && Boolean(payload)
      && [1, PROJECT_TOOLSET_SCHEMA_VERSION].includes(payload.schemaVersion)
      && payload.action === action
      && payload.ok === true,
    exitCode,
    payload,
    stdout: text,
    stderr: String(stderr ?? "").trim()
  };
}

function normalizedProfiles(manifest) {
  const profiles = Array.isArray(manifest?.profiles)
    ? manifest.profiles.filter((profile) => {
      return profile && typeof profile.id === "string" && profile.id.trim()
        && typeof profile.label === "string" && profile.label.trim();
    }).map((profile) => ({
      id: profile.id.trim(),
      label: profile.label.trim(),
      description: typeof profile.description === "string" ? profile.description.trim() : ""
    }))
    : [];
  return profiles.length > 0
    ? profiles
    : [{ id: "default", label: "Default", description: "Project default service configuration" }];
}

function selectedProfile(manifest) {
  const profiles = normalizedProfiles(manifest);
  const requested = typeof manifest?.selectedProfile === "string"
    ? manifest.selectedProfile.trim()
    : "";
  return profiles.some((profile) => profile.id === requested) ? requested : profiles[0].id;
}

function validateActivation({ source, profile, build, status, health, verify, version }) {
  if (status.payload?.running !== true) {
    return { ok: false, error: "The service did not remain running after restart." };
  }
  if (health.payload?.healthy !== true) {
    return { ok: false, error: health.payload?.detail || "The restarted service is unhealthy." };
  }
  if (!verify.ok || verify.payload?.verified !== true) {
    return { ok: false, error: verify.payload?.detail || "The service configuration could not be verified." };
  }
  const actual = version.payload ?? {};
  const built = build.payload ?? {};
  if (!version.ok || actual.verified !== true) {
    return { ok: false, error: "The running build identity could not be verified." };
  }
  if (!built.artifactId || actual.artifactId !== built.artifactId) {
    return { ok: false, error: "The running service does not use the artifact produced by this build." };
  }
  if (actual.revision !== source.revision || actual.sourceFingerprint !== source.fingerprint) {
    return { ok: false, error: "The running artifact does not match the requested Worktree contents." };
  }
  if (built.revision !== source.revision || built.sourceFingerprint !== source.fingerprint) {
    return { ok: false, error: "The build output does not match the requested Worktree contents." };
  }
  if (actual.profile !== profile || built.profile !== profile || verify.payload?.profile !== profile) {
    return { ok: false, error: "The running service profile does not match the selected profile." };
  }
  return { ok: true, error: null };
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
