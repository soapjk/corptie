import { execFileSync, execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ensureProjectLocalState, verifyProjectLocalState, writeProjectLocalFile } from "../runtime/projectLocalStateDirectory.mjs";

const require = createRequire(import.meta.url);
function failure(code, message) { return Object.assign(new Error(message), { code, status: 409 }); }

// Ordinary export confirmation is not permission to create repository files.
// Check actual Workspace roots, not git_repositories.path (the common .git
// directory). Also recognize unregistered repositories and symlink aliases.
export async function assertArtifactExportOutsideProjects({ destinationPath, projectRoots = [] }) {
  const requested = resolve(destinationPath);
  let cursor = requested;
  const missing = [];
  let existing;
  for (;;) {
    try { existing = await realpath(cursor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.unshift(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  const canonical = join(existing, ...missing);
  const inside = (path, root) => {
    const difference = relative(root, path);
    return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !difference.startsWith(sep));
  };
  const reject = () => { throw failure("ARTIFACT_PROJECT_EXPORT_FORBIDDEN", "Document export cannot write into a project. Use fixed-version materialization under .corptie/artifacts/, or exact user-authorized repository promotion for Git tracking."); };
  for (const root of new Set(projectRoots.filter(Boolean))) {
    const lexicalRoot = resolve(root);
    const canonicalRoot = await realpath(lexicalRoot).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return lexicalRoot;
    });
    if (inside(requested, lexicalRoot) || inside(canonical, canonicalRoot)) reject();
  }
  let directory = (await stat(existing)).isDirectory() ? existing : dirname(existing);
  for (;;) {
    const marker = await lstat(join(directory, ".git")).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (marker) reject();
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

export function publishArtifactRepositoryFile({ cwd, path, content }) {
  if (!cwd) throw failure("ARTIFACT_WORKSPACE_REQUIRED", "The authenticated Session has no workspace.");
  if (!path || path.includes("\\") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === ".." || [".git", ".corptie"].includes(part.toLowerCase()))) {
    throw failure("ARTIFACT_PATH_INVALID", "Unsafe repository target.");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const root = realpathSync(execFileSync("git", ["-C", realpathSync(cwd), "rev-parse", "--show-toplevel"], { env, encoding: "utf8", timeout: 10000 }).trim());
  const native = require("../../native/corptie_native.node");
  native.writeNewFileOpenat(root, path, content);
  return { repositoryPath: root, path };
}

export async function materializeArtifactBytes({ cwd, relativePath, content }) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")
    || relativePath.includes("\0") || relativePath.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.toLowerCase() === ".gitignore")) {
    throw failure("ARTIFACT_PATH_INVALID", "Use a nonempty safe path relative to .corptie, excluding Git control files.");
  }
  if (!relativePath.startsWith("artifacts/") || relativePath.length === "artifacts/".length) {
    throw failure("ARTIFACT_PATH_INVALID", "Artifact files must be materialized under .corptie/artifacts/; use path=artifacts/<name>.");
  }
  if (!cwd) throw failure("ARTIFACT_WORKSPACE_REQUIRED", "The authenticated Session has no bound workspace.");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await promisify(execFile)("git", ["-C", realpathSync(cwd), "rev-parse", "--show-toplevel"],
    { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  const root = realpathSync(result.stdout.trim());
  let localState;
  try {
    localState = await ensureProjectLocalState(root, { scope: "worktreeLocal" });
    await verifyProjectLocalState(localState);
  } catch (error) {
    if (error.code === "LOCAL_STATE_TRACKED") throw failure("ARTIFACT_CORPTIE_TRACKED", error.message);
    if (["LOCAL_STATE_IGNORE_CONFLICT", "LOCAL_STATE_NOT_IGNORED"].includes(error.code)) throw failure("ARTIFACT_NOT_IGNORED", error.message);
    throw error;
  }
  const target = `.corptie/${relativePath}`;
  writeProjectLocalFile(localState, relativePath, content);
  await verifyProjectLocalState(localState);
  return { path: join(root, target), repositoryPath: root, gitIgnored: true, gitTracked: false };
}
