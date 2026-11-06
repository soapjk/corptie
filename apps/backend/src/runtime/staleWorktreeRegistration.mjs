import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";

// Only an absent directory qualifies. Permission errors, dangling symlinks and
// missing mount roots must never be interpreted as permission to remove data.
export async function staleRegistrationAction(tree) {
  if (tree.isMain || tree.isLocked || !tree.isPrunable || tree.availability === "available") return null;
  if (["/net/", "/Network/", "/mnt/", "/media/"].some(prefix => resolve(tree.path).startsWith(prefix))) return null;
  // An offline macOS volume may leave an empty mount-point directory behind.
  // Require an actual mounted device before treating paths beneath it as absent.
  if (resolve(tree.path).startsWith("/Volumes/")) {
    const volume = resolve(tree.path).split("/").slice(0, 3).join("/");
    try {
      const [entry, parent] = await Promise.all([lstat(volume), lstat("/Volumes")]);
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev === parent.dev) return null;
    } catch { return null; }
  }
  try { await lstat(tree.path); return null; }
  catch (error) { if (error.code !== "ENOENT") return null; }
  let ancestor = dirname(resolve(tree.path));
  while (true) {
    if (["/", "/Volumes", "/mnt", "/media", "/net", "/Network"].includes(ancestor)) return null;
    try {
      const entry = await lstat(ancestor);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
      await access(ancestor, constants.R_OK | constants.X_OK);
      return { kind: "remove_stale_registration", available: true };
    } catch (error) {
      if (error.code !== "ENOENT") return null;
      ancestor = dirname(ancestor);
    }
  }
}
