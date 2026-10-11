import { realpath } from "node:fs/promises";
import { resolve, posix } from "node:path";

// Identity is independent of display names and manifest-only content hashes.
// Local aliases resolve to the selected Skill directory, including symlinks.
export async function skillInstallationIdentity(skill) {
  if (skill.sourceType !== "git") {
    const path = resolve(skill.source, skill.sourceSubpath || ".");
    try { return JSON.stringify(["local", await realpath(path)]); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return JSON.stringify(["local", path]);
    }
  }
  let source = String(skill.source).trim();
  const scp = source.match(/^git@([^:]+):(.+)$/);
  if (scp) source = `ssh://git@${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(source);
    // Only these well-known hosting aliases have established equivalent identity.
    if (["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname)
      && ["https:", "ssh:"].includes(url.protocol) && !url.port && !url.search && !url.hash) {
      source = `${url.hostname}/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
    }
  } catch { /* Unknown origins remain distinct; do not guess equivalence. */ }
  return JSON.stringify(["git", source, posix.normalize(skill.sourceSubpath || ".")]);
}

// The backend has one Store writer. Share the queue across service instances;
// keep check/create/materialization together so pending installs cannot be reused.
const mutations = new WeakMap();
export async function withSkillRegistryMutation(store, operation) {
  const previous = mutations.get(store) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  mutations.set(store, pending);
  try { return await pending; }
  finally { if (mutations.get(store) === pending) mutations.delete(store); }
}
