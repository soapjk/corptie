import { execFileSync, execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureProjectLocalState, verifyProjectLocalState, writeProjectLocalFile } from "../runtime/projectLocalStateDirectory.mjs";

const require = createRequire(import.meta.url);
function failure(code, message) { return Object.assign(new Error(message), { code, status: 409 }); }

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
