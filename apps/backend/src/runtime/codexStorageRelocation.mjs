import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { atomicWriteJson } from "./dataRootLayout.mjs";

export async function rebaseCodexStoragePaths({ sourceLayout, targetLayout, stagingLayout }) {
  const path = join(stagingLayout.dataRoot, "codex-environments.json");
  let registry;
  try { registry = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (registry.version !== 1 || !registry.profiles) throw new Error("Codex environment registry is invalid.");
  for (const profile of Object.values(registry.profiles)) {
    if (profile.mode !== "isolated") continue;
    const suffix = relative(sourceLayout.dataRoot, profile.home);
    if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) continue;
    profile.home = join(targetLayout.dataRoot, suffix);
  }
  // Keep profile and thread IDs stable even though their filesystem path moved.
  await atomicWriteJson(path, registry);
}
