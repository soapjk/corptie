import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join } from "node:path";

// Repair old missing identity metadata, never import Provider history into the
// product timeline. Read only the authoritative isolated runtime directory.
export async function recoverClaudeSessionIdentity({ configDirectory, cwd, logicalSessionId }) {
  if (!configDirectory || !cwd || !logicalSessionId) return null;
  try {
    const canonicalCwd = await realpath(cwd);
    const prefix = canonicalCwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 100);
    const root = join(configDirectory, "projects");
    const directories = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix));
    const matches = new Set();
    let inspected = 0;
    for (const directory of directories) {
      const project = join(root, directory.name);
      for (const entry of await readdir(project, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (++inspected > 64) return null;
        const path = join(project, entry.name);
        if ((await stat(path)).size > 32 * 1024 * 1024) return null;
        const sessionId = entry.name.slice(0, -6);
        for (const line of (await readFile(path, "utf8")).split("\n")) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row.type !== "user" || row.sessionId !== sessionId || row.cwd !== canonicalCwd) continue;
          const content = typeof row.message?.content === "string" ? row.message.content
            : (row.message?.content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
          if (content.includes(`<corptie_direct_user_message_evidence logical_session_id="${logicalSessionId}"`)) {
            matches.add(sessionId);
            break;
          }
        }
      }
    }
    return matches.size === 1 ? [...matches][0] : null;
  } catch { return null; }
}
