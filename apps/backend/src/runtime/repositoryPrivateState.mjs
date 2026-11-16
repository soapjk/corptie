import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ensureProjectLocalState, inspectProjectLocalState, readProjectLocalFile, writeProjectLocalFile } from "./projectLocalStateDirectory.mjs";

// Project data lives in the main checkout's .corptie, shared by linked worktrees.
export async function repositoryPrivateRoot(cwd, git) {
  const lines = (await git(cwd, ["worktree", "list", "--porcelain", "-z"])).split("\0");
  const main = lines.find(line => line.startsWith("worktree "))?.slice(9);
  if (!main) throw new Error("Repository main worktree is unavailable.");
  return realpath(main);
}

export async function readRepositoryPrivateState(root, path) {
  const exists = await lstat(join(root, ".corptie", path)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  if (!exists) return null;
  const inspected = await inspectProjectLocalState(root, { scope: "projectShared" });
  if (inspected.state !== "ready") throw Object.assign(new Error(inspected.message ?? "Repository private state is unsafe."), { code: inspected.code });
  const receipt = await ensureProjectLocalState(root, { scope: "projectShared" });
  return JSON.parse((await readProjectLocalFile(receipt, path)).content.toString());
}

export async function publishRepositoryPrivateState(root, path, value) {
  const receipt = await ensureProjectLocalState(root, { scope: "projectShared" });
  try { writeProjectLocalFile(receipt, path, Buffer.from(JSON.stringify(value) + "\n")); }
  catch (error) {
    if (error.code !== "ARTIFACT_DESTINATION_EXISTS") throw error;
    const current = await readRepositoryPrivateState(root, path);
    if (JSON.stringify(current) !== JSON.stringify(value)) throw Object.assign(new Error("Repository private state ownership changed."), { code: "REPOSITORY_PRIVATE_STATE_CONFLICT" });
  }
}

export const ownerStatePath = suffix => {
  if (!/^[a-z0-9-]+$/i.test(suffix)) throw new Error("Invalid Task worktree suffix.");
  return `git/task-worktrees/${suffix}.json`;
};
export const WARNING_STATE_PATH = "git/private-files-warning-disabled.json";

// One-way migration only. Publish durable private state before removing an
// exact old key/value. Unknown keys and values are preserved for inspection.
export async function migrateRepositoryGitState(root, git) {
  const raw = await git(root, ["config", "--local", "--get-regexp", "^(corptie-task-worktree\\..*\\.task-id|corptie\\.privatefileswarning)$"])
    .catch(error => { if (error.code === 1) return ""; throw error; });
  for (const line of raw.split("\n").filter(Boolean)) {
    const split = line.indexOf(" ");
    if (split < 0) continue;
    const key = line.slice(0, split), value = line.slice(split + 1);
    const suffix = /^corptie-task-worktree\.([a-z0-9-]+)\.task-id$/i.exec(key)?.[1];
    if (suffix && /^task:[a-z0-9-]+$/i.test(value)) await publishRepositoryPrivateState(root, ownerStatePath(suffix), { taskId: value });
    else if (key.toLowerCase() === "corptie.privatefileswarning" && value === "false")
      await publishRepositoryPrivateState(root, WARNING_STATE_PATH, { disabled: true });
    else continue;
    await git(root, ["config", "--local", "--fixed-value", "--unset-all", key, value])
      .catch(error => { if (error.code !== 5) throw error; });
  }
}
