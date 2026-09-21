import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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

export function materializeArtifactBytes({ cwd, relativePath, content }) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")
    || relativePath.includes("\0") || relativePath.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.toLowerCase() === ".gitignore")) {
    throw failure("ARTIFACT_PATH_INVALID", "Use a nonempty safe path relative to .corptie, excluding Git control files.");
  }
  if (!cwd) throw failure("ARTIFACT_WORKSPACE_REQUIRED", "The authenticated Session has no bound workspace.");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (directory, args) => execFileSync("git", ["-C", directory, ...args], { env, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const root = realpathSync(git(realpathSync(cwd), ["rev-parse", "--show-toplevel"]).trim());
  const tracked = git(root, ["ls-files", "-z", "--", ":(icase).corptie"]);
  if (tracked) throw failure("ARTIFACT_CORPTIE_TRACKED", "Project .corptie content is already tracked; materialization is refused.");
  const native = require("../../native/corptie_native.node");
  if (typeof native.writeNewFileOpenat !== "function") throw failure("ARTIFACT_NATIVE_SAFETY_UNAVAILABLE", "Native atomic file publication is required.");
  try { native.writeNewFileOpenat(root, ".corptie/.gitignore", Buffer.from("*\n")); }
  catch (error) { if (!error.message.includes("ARTIFACT_DESTINATION_EXISTS")) throw error; }
  const target = `.corptie/${relativePath}`;
  try { git(root, ["check-ignore", "--quiet", "--", target]); }
  catch { throw failure("ARTIFACT_NOT_IGNORED", "The materialization target must be ignored by Git."); }
  native.writeNewFileOpenat(root, target, content);
  return { path: join(root, target), repositoryPath: root, gitIgnored: true, gitTracked: false };
}
