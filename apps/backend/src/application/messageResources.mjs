import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MESSAGE_RESOURCE_MAX_BYTES = 20 * 1024 * 1024;
const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain",
  ".json": "application/json", ".md": "text/plain" };
const unavailable = () => Object.assign(new Error("Message resource is unavailable or not permitted."),
  { code: "MESSAGE_RESOURCE_UNAVAILABLE", statusCode: 404 });

/** Only explicit Markdown destinations in this exact message grant a reference.
 * No text substring matching and no caller-supplied directory authority.
 */
export function messageResourceLinks(text) {
  const links = [];
  let fence = null;
  for (const line of String(text ?? "").split("\n")) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1]?.[0];
    if (marker) { if (fence === marker) fence = null; else if (!fence) fence = marker; continue; }
    if (fence) continue;
    for (const match of line.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      links.push(match[1] ?? match[2]);
      if (links.length === 64) return links;
    }
  }
  return links;
}

function localPath(value) {
  if (value.startsWith("file:")) {
    try { return fileURLToPath(value); } catch { throw unavailable(); }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw unavailable();
  try { return decodeURIComponent(value); } catch { throw unavailable(); }
}

/** Read-only, Session-scoped legacy resource resolution. Never expose arbitrary host paths. */
export async function resolveMessageResource({ store, environmentRoot, ownedImageRoot, reference, itemId, path }) {
  if (typeof itemId !== "string" || !itemId || itemId.length > 512
      || typeof path !== "string" || !path || path.length > 4096) throw unavailable();
  // Timeline rows use the durable Session key resolved by SessionBindingRepository,
  // not its logical routing identifier.
  const sessionId = reference.sessionId ?? reference.logicalSessionId;
  const item = store?.getSessionItem(sessionId, itemId);
  if (!item || !["agentMessage", "userMessage", "imageView"].includes(item.type)) throw unavailable();
  const session = reference.metadata?.session ?? store.getSession(sessionId);
  function absolute(value) {
    const decoded = localPath(value);
    if (isAbsolute(decoded)) return resolve(decoded);
    if (!session?.cwd || !isAbsolute(session.cwd)) throw unavailable();
    return resolve(session.cwd, decoded);
  }
  const requested = absolute(path);
  const links = item.type === "imageView" ? [String(item.text ?? "").trim()] : messageResourceLinks(item.text);
  if (!links.some(link => {
    try { return absolute(link) === requested; } catch { return false; }
  })) throw unavailable();
  const mimeType = types[extname(requested).toLowerCase()];
  if (!mimeType) throw unavailable();
  const roots = [environmentRoot && resolve(environmentRoot, "tmp"), session?.cwd, ownedImageRoot].filter(Boolean);
  const candidate = await realpath(requested).catch(() => { throw unavailable(); });
  let permitted = false;
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => null);
    if (!canonical || canonical === sep) continue;
    // Both lexical and canonical containment are required: symlink escapes fail.
    const lexical = relative(resolve(root), resolve(requested));
    const actual = relative(canonical, candidate);
    if ([lexical, actual].every(part => part && !isAbsolute(part)
      && part.split(sep).every(component => component !== ".." && !component.startsWith(".")))) {
      permitted = true; break;
    }
  }
  if (!permitted) throw unavailable();
  return { candidate, mimeType };
}

export async function readMessageResource(options) {
  const { candidate, mimeType } = await resolveMessageResource(options);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw unavailable(); });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MESSAGE_RESOURCE_MAX_BYTES) throw unavailable();
    // Bounded read even if the file grows concurrently.
    const data = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < data.length) {
      const { bytesRead } = await handle.read(data, count, data.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== info.size) throw unavailable();
    return { data: data.subarray(0, count), mimeType, byteLength: count, fileName: basename(candidate) };
  } finally { await handle.close(); }
}
