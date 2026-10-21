import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureProjectLocalState, readProjectLocalFile, writeProjectLocalFile, verifyProjectLocalState } from "./projectLocalStateDirectory.mjs";

const pins = new WeakMap();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => Object.assign(new Error(message), { code: "TOOLSET_SNAPSHOT_INVALID" });

// The object is an opaque in-process capability. A caller cannot substitute a
// different path/hash. Durable Toolset/Run receipts remain their existing truth.
export async function pinToolsetExecution(state, identity, source, owner = "worktree") {
  const shared = await ensureProjectLocalState(state.mainPath, { scope: "projectShared" });
  const files = [];
  let bytes = 0;
  let entries = 0;
  const add = async path => {
    const file = await readProjectLocalFile(shared, path);
    bytes += file.content.length;
    if (files.length >= 128 || bytes > 2 * 1024 * 1024) throw fail("Toolset snapshot exceeds bounded storage limits.");
    files.push({ path, ...file });
  };
  await add("toolset.json");
  const visit = async (path, depth) => {
    if (++entries > 128) throw fail("Toolset scripts exceed the entry limit.");
    if (depth > 5) throw fail("Toolset scripts exceed the depth limit.");
    const info = await lstat(join(state.toolsetPath, path));
    if (info.isSymbolicLink()) throw fail("Toolset scripts may not contain symbolic links.");
    if (info.isFile()) return add(path);
    if (!info.isDirectory()) throw fail("Toolset scripts contain an unsupported file type.");
    const names = [];
    for await (const entry of await opendir(join(state.toolsetPath, path))) {
      if (names.length >= 128) throw fail("Toolset scripts exceed the entry limit.");
      names.push(entry.name);
    }
    for (const name of names.sort()) await visit(`${path}/${name}`, depth + 1);
  };
  await visit("scripts", 0);
  // Re-read every file through bound openat descriptors before publication.
  for (const file of files) {
    const current = await readProjectLocalFile(shared, file.path);
    if (!file.content.equals(current.content) || file.executable !== current.executable) throw fail("Shared tool definitions changed while pinning; retry.");
  }
  await verifyProjectLocalState(shared);
  const manifest = JSON.parse(files[0].content.toString("utf8"));
  if (JSON.stringify(manifest) !== JSON.stringify(state.manifest)) throw fail("Toolset manifest changed while pinning; retry.");
  const version = hash(JSON.stringify(files.map(file => ({ path: file.path, hash: hash(file.content), executable: file.executable }))));
  const local = await ensureProjectLocalState(identity.canonicalPath, { scope: "worktreeLocal" });
  const prefix = `toolset-snapshots/${hash(String(owner))}/${version}`;
  for (const file of files) {
    const path = `${prefix}/${file.path}`;
    try { writeProjectLocalFile(local, path, file.content); }
    catch (error) { if (error.code !== "ARTIFACT_DESTINATION_EXISTS") throw error; }
    const copy = await readProjectLocalFile(local, path, { executable: file.executable, expectedContent: file.content });
    if (!copy.content.equals(file.content)) throw fail("An existing toolset snapshot was modified; it was not overwritten.");
  }
  // A version-local runtime is intentional for legacy adapters that use
  // $CORPTIE_TOOLSET_ROOT/runtime. It never aliases main or another Worktree.
  try { writeProjectLocalFile(local, `${prefix}/runtime/.keep`, Buffer.alloc(0)); }
  catch (error) { if (error.code !== "ARTIFACT_DESTINATION_EXISTS") throw error; }
  const pin = Object.freeze({ schemaVersion: 1, contentHash: version, root: join(identity.canonicalPath, ".corptie", prefix),
    repositoryId: identity.repositoryId, worktreeId: identity.worktreeId, sourceFingerprint: source.fingerprint });
  pins.set(pin, { local, prefix, files, manifest, owner });
  return pin;
}

export async function verifyToolsetExecution(pin, identity, source, owner = undefined) {
  const data = pins.get(pin);
  if (!data || pin.repositoryId !== identity.repositoryId || pin.worktreeId !== identity.worktreeId
      || pin.sourceFingerprint !== source.fingerprint || (owner !== undefined && data.owner !== owner)) throw fail("Toolset snapshot binding does not match this execution.");
  await verifyProjectLocalState(data.local);
  for (const file of data.files) {
    const copy = await readProjectLocalFile(data.local, `${data.prefix}/${file.path}`);
    if (!copy.content.equals(file.content) || file.executable !== copy.executable) throw fail("Pinned toolset files changed; execution refused.");
  }
  return { manifest: data.manifest, root: pin.root };
}
