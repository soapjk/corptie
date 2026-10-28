import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

function storageError(message) {
  return Object.assign(new Error(message), { code: "ARTIFACT_STORAGE_KEY_INVALID", statusCode: 409 });
}

function readableName(value, fallback) {
  let name = String(value || fallback).normalize("NFKC")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/gu, "_").replace(/^\.+|[. ]+$/gu, "");
  while (Buffer.byteLength(name) > 80) name = [...name].slice(0, -1).join("");
  return name || fallback;
}

// Names are creation-time snapshots, not a second source of ownership truth.
// Keys are allocated once in SQLite; extending a collision never renames peers.
function directorySegment(store, kind, id, title) {
  if (!id) throw storageError(`Missing ${kind} ownership identity.`);
  const existing = store.selectOne("SELECT directory_name FROM artifact_storage_directories WHERE entity_kind=? AND entity_id=?", [kind, id]);
  if (existing) return existing.directory_name;
  return store.runInTransaction(() => {
    const existing = store.selectOne("SELECT directory_name FROM artifact_storage_directories WHERE entity_kind=? AND entity_id=?", [kind, id]);
    if (existing) return existing.directory_name;
    const identity = id.slice(id.indexOf(":") + 1).replace(/[^a-zA-Z0-9]/gu, "").toLowerCase() || kind;
    let length = Math.min(4, identity.length);
    let key = identity.slice(0, length);
    let suffix = 1;
    while (store.selectOne("SELECT 1 FROM artifact_storage_directories WHERE entity_kind=? AND directory_key=?", [kind, key])) {
      key = length < identity.length ? identity.slice(0, ++length) : `${identity}_${++suffix}`;
    }
    const name = `${readableName(title, kind)}--${kind[0]}_${key}`;
    store.db.run("INSERT INTO artifact_storage_directories(entity_kind, entity_id, directory_key, directory_name) VALUES (?, ?, ?, ?)", [kind, id, key, name]);
    return name;
  });
}

export function resolveArtifactStorageContainer(store, artifact) {
  const segment = (kind, id, title) => directorySegment(store, kind, id, title);
  let owner = "";
  if (artifact.workId) {
    const work = store.getWork(artifact.workId);
    if (!work) throw storageError("Artifact Work no longer exists; retain its original content.");
    owner = join("works", segment("work", artifact.workId, work.name));
  }
  if (artifact.scope === "task") {
    const task = store.getTask(artifact.boundTaskId);
    if (!task || task.work_id !== artifact.workId) throw storageError("Artifact Task binding is unavailable.");
    owner = join(owner, "tasks", segment("task", artifact.boundTaskId, task.title));
  } else if (artifact.scope === "session") {
    const session = store.getSession(artifact.boundSessionId);
    if (!session || (session.workId ?? session.work_id ?? null) !== (artifact.workId ?? null)) throw storageError("Artifact Session binding is unavailable.");
    const taskId = session.taskId ?? session.task_id;
    if (taskId) {
      const task = store.getTask(taskId);
      if (!task || task.work_id !== artifact.workId) throw storageError("Artifact Session Task is unavailable.");
      owner = join(owner, "tasks", segment("task", taskId, task.title));
    }
    owner = join(owner, "sessions", segment("session", artifact.boundSessionId, session.title));
  } else if (artifact.scope !== "work" || !artifact.workId) {
    throw storageError("Artifact ownership scope is invalid.");
  }
  return join(owner, "artifacts", segment("artifact", artifact.artifactId, artifact.title));
}

export function resolveArtifactVersionStorageKey(store, artifact, version, filename) {
  if (!Number.isSafeInteger(version) || version < 1) throw storageError("Invalid Artifact version.");
  return join(resolveArtifactStorageContainer(store, artifact), "versions", `v${String(version).padStart(6, "0")}`, filename);
}

function storageDirectoryIdentities(store, artifacts) {
  const ids = new Map();
  const add = (kind, id) => { if (id) ids.set(JSON.stringify([kind, id]), [kind, id]); };
  for (const artifact of artifacts) {
    add("artifact", artifact.artifactId);
    add("work", artifact.workId);
    add("task", artifact.boundTaskId);
    if (artifact.boundSessionId) {
      add("session", artifact.boundSessionId);
      const session = store.getSession(artifact.boundSessionId);
      const taskId = session?.taskId ?? session?.task_id;
      add("task", taskId);
    }
  }
  return ids;
}

export function artifactStorageDirectorySnapshots(store, artifacts) {
  return [...storageDirectoryIdentities(store, artifacts).values()].flatMap(identity =>
    store.selectAll("SELECT * FROM artifact_storage_directories WHERE entity_kind=? AND entity_id=?", identity));
}

export function restoreArtifactStorageDirectories(store, rows = [], artifacts = []) {
  const allowed = storageDirectoryIdentities(store, artifacts);
  store.runInTransaction(() => {
    for (const row of rows) {
      if (!allowed.has(JSON.stringify([row.entity_kind, row.entity_id]))
        || !["work", "task", "session", "artifact"].includes(row.entity_kind)
        || typeof row.entity_id !== "string" || !/^[a-z0-9_]+$/u.test(row.directory_key)
        || typeof row.directory_name !== "string" || Buffer.byteLength(row.directory_name) > 200
        || /[\x00-\x1f\x7f<>:"/\\|?*]/u.test(row.directory_name)
        || row.directory_name.startsWith(".")
        || !row.directory_name.endsWith(`--${row.entity_kind[0]}_${row.directory_key}`)) {
        throw storageError("Invalid backed-up Artifact directory identity.");
      }
      if (store.selectOne("SELECT 1 FROM artifact_storage_directories WHERE entity_kind=? AND entity_id=?", [row.entity_kind, row.entity_id])) continue;
      if (store.selectOne("SELECT 1 FROM artifact_storage_directories WHERE entity_kind=? AND directory_key=?", [row.entity_kind, row.directory_key])) {
        throw storageError("Backed-up directory identity is occupied; existing directories were not renamed.");
      }
      store.db.run("INSERT INTO artifact_storage_directories VALUES (?, ?, ?, ?)", [row.entity_kind, row.entity_id, row.directory_key, row.directory_name]);
    }
  });
}

// Inspect every existing component, including the leaf. Lexical containment alone
// does not prevent a nested directory symlink from escaping private storage.
export function safeArtifactStoragePath(root, key) {
  if (typeof key !== "string" || !key || key.includes("\0")) throw storageError("Invalid Artifact storage key.");
  const base = resolve(root);
  const path = resolve(base, key);
  if (!path.startsWith(`${base}${sep}`)) throw storageError("Artifact storage key escaped private storage.");
  let current = base;
  for (const part of relative(base, path).split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw storageError("Artifact storage paths must not contain symbolic links.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return path;
}

export async function ensureArtifactStorageParent(root, key) {
  const path = safeArtifactStoragePath(root, key);
  let current = resolve(root);
  for (const part of relative(current, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    safeArtifactStoragePath(root, relative(root, join(current, ".probe")));
  }
  return safeArtifactStoragePath(root, key);
}
